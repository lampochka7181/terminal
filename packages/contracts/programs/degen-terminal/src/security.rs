use anchor_lang::prelude::*;
use anchor_lang::solana_program::ed25519_program;
use anchor_lang::solana_program::hash::hashv;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked,
    load_instruction_at_checked,
};
use anchor_spl::token::TokenAccount;
use std::str::FromStr;

use crate::errors::DegenError;
use crate::instructions::PlaceOrderArgs;
use crate::session::SessionAuthority;
use crate::state::OrderType;
use crate::state::Market;
use crate::state_v2::MarketV2;

const ORDER_MESSAGE_PREFIX: &[u8] = b"DT_ORDER_V1";
const SESSION_GRANT_MESSAGE_PREFIX: &[u8] = b"DT_SESSION_GRANT_V1";

struct ParsedOrderMessage {
    market: Pubkey,
    owner: Pubkey,
    signer: Pubkey,
    side: u8,
    outcome: u8,
    order_type: u8,
    price: u64,
    size: u64,
    expiry_ts: i64,
    client_order_id: u64,
}

struct ParsedSessionGrantMessage {
    program_id: Pubkey,
    wallet: Pubkey,
    session_pubkey: Pubkey,
    session_authority: Pubkey,
    expires_at: i64,
}

pub fn require_market_vault(market: &Market, market_key: &Pubkey, vault_key: &Pubkey, vault: &TokenAccount) -> Result<()> {
    require!(
        market.matches_vault(market_key, vault_key, &vault.owner, &vault.mint),
        DegenError::InvalidMarketParams
    );
    Ok(())
}

pub fn require_market_v2_vault(
    market: &MarketV2,
    market_key: &Pubkey,
    vault_key: &Pubkey,
    vault: &TokenAccount,
) -> Result<()> {
    require!(
        market.matches_vault(market_key, vault_key, &vault.owner, &vault.mint),
        DegenError::InvalidMarketParams
    );
    Ok(())
}

pub fn build_order_message_bytes(
    market: &Pubkey,
    order_owner: &Pubkey,
    signer: &Pubkey,
    args: &PlaceOrderArgs,
) -> Vec<u8> {
    let mut message = Vec::with_capacity(ORDER_MESSAGE_PREFIX.len() + 131);
    message.extend_from_slice(ORDER_MESSAGE_PREFIX);
    message.extend_from_slice(market.as_ref());
    message.extend_from_slice(order_owner.as_ref());
    message.extend_from_slice(signer.as_ref());
    message.push(args.side as u8);
    message.push(args.outcome as u8);
    message.push(args.order_type as u8);
    message.extend_from_slice(&args.price.to_le_bytes());
    message.extend_from_slice(&args.size.to_le_bytes());
    message.extend_from_slice(&args.expiry_ts.to_le_bytes());
    message.extend_from_slice(&args.client_order_id.to_le_bytes());
    message
}

pub fn require_order_signature(
    instructions_sysvar: &AccountInfo,
    expected_signer: &Pubkey,
)-> Result<Vec<u8>> {
    let current_index = load_current_index_checked(instructions_sysvar)? as usize;
    let mut saw_ed25519 = false;

    for index in 0..current_index {
        let instruction = load_instruction_at_checked(index, instructions_sysvar)?;
        if instruction.program_id != ed25519_program::ID {
            continue;
        }

        saw_ed25519 = true;
        let (signer, message) = parse_ed25519_instruction(&instruction.data)?;
        if signer != *expected_signer {
            continue;
        }
        return Ok(message);
    }

    if saw_ed25519 {
        err!(DegenError::SignerMismatch)
    } else {
        err!(DegenError::MissingSignatureVerification)
    }
}

pub fn require_order_authorization(
    instructions_sysvar: &AccountInfo,
    session_authority_info: &AccountInfo,
    market: &Pubkey,
    order_owner: &Pubkey,
    signer: &Pubkey,
    args: &PlaceOrderArgs,
) -> Result<()> {
    let verified_message = require_order_signature(instructions_sysvar, signer)?;
    let parsed_message = match parse_compact_order_message(&verified_message, market, order_owner, signer, args)? {
        Some(parsed) => parsed,
        None => parse_order_message(&verified_message)?,
    };

    require!(parsed_message.market == *market, DegenError::InvalidSignature);
    require!(parsed_message.owner == *order_owner, DegenError::Unauthorized);
    require!(parsed_message.signer == *signer, DegenError::SignerMismatch);
    require!(parsed_message.side == args.side as u8, DegenError::InvalidSignature);
    require!(parsed_message.outcome == args.outcome as u8, DegenError::InvalidSignature);
    require!(parsed_message.order_type == args.order_type as u8, DegenError::InvalidSignature);
    require!(parsed_message.client_order_id == args.client_order_id, DegenError::InvalidSignature);
    require!(parsed_message.expiry_ts == args.expiry_ts, DegenError::InvalidSignature);
    match args.order_type {
        OrderType::Limit | OrderType::IOC | OrderType::FOK => {
            require!(parsed_message.size >= args.size, DegenError::InvalidSignature);
            require!(parsed_message.price == args.price, DegenError::PriceMismatch);
        }
        OrderType::Market => {
            if args.side as u8 == 0 {
                require!(parsed_message.price >= args.price, DegenError::PriceMismatch);
                let max_notional = args.price
                    .checked_mul(args.size).ok_or(DegenError::MathOverflow)?
                    .checked_add(999_999).ok_or(DegenError::MathOverflow)?
                    .checked_div(1_000_000).ok_or(DegenError::DivisionByZero)?;
                require!(parsed_message.size >= max_notional, DegenError::InvalidSignature);
            } else {
                require!(parsed_message.price <= args.price, DegenError::PriceMismatch);
                require!(parsed_message.size >= args.size, DegenError::InvalidSignature);
            }
        }
    }

    if signer == order_owner {
        return Ok(());
    }

    require!(session_authority_info.owner == &crate::ID, DegenError::Unauthorized);
    let mut session_data: &[u8] = &session_authority_info.try_borrow_data()?;
    let session_authority = SessionAuthority::try_deserialize(&mut session_data)?;
    let now = Clock::get()?.unix_timestamp;

    require!(session_authority.wallet == *order_owner, DegenError::Unauthorized);
    require!(session_authority.session_pubkey == *signer, DegenError::SignerMismatch);
    require!(!session_authority.revoked, DegenError::Unauthorized);
    require!(session_authority.expires_at > now, DegenError::SessionExpired);
    Ok(())
}

fn parse_compact_order_message(
    data: &[u8],
    market: &Pubkey,
    order_owner: &Pubkey,
    signer: &Pubkey,
    args: &PlaceOrderArgs,
) -> Result<Option<ParsedOrderMessage>> {
    let text = match std::str::from_utf8(data) {
        Ok(text) => text,
        Err(_) => return Ok(None),
    };
    let mut lines = text.lines();
    if lines.next() != Some("DT_ORDER_V1") {
        return Ok(None);
    }
    let ctx_line = match lines.next() {
        Some(line) => line,
        None => return Ok(None),
    };
    let price = match parse_order_u64_line(lines.next(), "p=") {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let size = match parse_order_u64_line(lines.next(), "s=") {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let expiry_ts = match parse_grant_i64_line(lines.next(), "e=") {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let client_order_id = match parse_order_u64_line(lines.next(), "c=") {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if lines.next().is_some() {
        return Ok(None);
    }
    let provided_hash = match ctx_line.strip_prefix("ctx=") {
        Some(value) => value,
        None => return Ok(None),
    };

    let expected_preimage = build_order_context_bytes(market, order_owner, signer, args);
    let expected_hash = hashv(&[&expected_preimage]);
    let expected_hex = to_lower_hex(expected_hash.as_ref());
    require!(provided_hash == expected_hex, DegenError::InvalidSignature);
    Ok(Some(ParsedOrderMessage {
        market: *market,
        owner: *order_owner,
        signer: *signer,
        side: args.side as u8,
        outcome: args.outcome as u8,
        order_type: args.order_type as u8,
        price,
        size,
        expiry_ts,
        client_order_id,
    }))
}

pub fn require_session_grant_authorization(
    instructions_sysvar: &AccountInfo,
    session_authority_key: &Pubkey,
    wallet: &Pubkey,
    session_pubkey: &Pubkey,
    expires_at: i64,
) -> Result<()> {
    let verified_message = require_order_signature(instructions_sysvar, wallet)?;
    let parsed_message = parse_session_grant_message(&verified_message)?;
    let (derived_session_authority, _) = Pubkey::find_program_address(
        &[SessionAuthority::SEED, wallet.as_ref(), session_pubkey.as_ref()],
        &crate::ID,
    );

    require!(parsed_message.program_id == crate::ID, DegenError::InvalidSignature);
    require!(parsed_message.wallet == *wallet, DegenError::Unauthorized);
    require!(parsed_message.session_pubkey == *session_pubkey, DegenError::SignerMismatch);
    require!(parsed_message.session_authority == *session_authority_key, DegenError::InvalidSignature);
    require!(parsed_message.session_authority == derived_session_authority, DegenError::InvalidSignature);
    require!(parsed_message.expires_at == expires_at, DegenError::InvalidSignature);
    Ok(())
}

fn parse_ed25519_instruction(data: &[u8]) -> Result<(Pubkey, Vec<u8>)> {
    require!(data.len() >= 16, DegenError::InvalidSignature);
    require!(data[0] == 1, DegenError::InvalidSignature);

    let signature_instruction_index = read_u16(data, 4)?;
    let pubkey_offset = read_u16(data, 6)? as usize;
    let pubkey_instruction_index = read_u16(data, 8)?;
    let message_offset = read_u16(data, 10)? as usize;
    let message_size = read_u16(data, 12)? as usize;
    let message_instruction_index = read_u16(data, 14)?;

    require!(
        signature_instruction_index == u16::MAX &&
        pubkey_instruction_index == u16::MAX &&
        message_instruction_index == u16::MAX,
        DegenError::InvalidSignature
    );

    let pubkey_end = pubkey_offset.checked_add(32).ok_or(DegenError::MathOverflow)?;
    let message_end = message_offset.checked_add(message_size).ok_or(DegenError::MathOverflow)?;

    require!(data.len() >= pubkey_end, DegenError::InvalidSignature);
    require!(data.len() >= message_end, DegenError::InvalidSignature);

    let signer = Pubkey::new_from_array(
        data[pubkey_offset..pubkey_end]
            .try_into()
            .map_err(|_| error!(DegenError::InvalidSignature))?,
    );
    let message = data[message_offset..message_end].to_vec();
    Ok((signer, message))
}

fn parse_order_message(data: &[u8]) -> Result<ParsedOrderMessage> {
    let legacy_len = ORDER_MESSAGE_PREFIX.len() + 131;
    if data.len() == legacy_len && &data[..ORDER_MESSAGE_PREFIX.len()] == ORDER_MESSAGE_PREFIX {
        return parse_order_message_binary(data);
    }

    parse_order_message_text(data)
}

fn parse_order_message_binary(data: &[u8]) -> Result<ParsedOrderMessage> {
    let mut offset = ORDER_MESSAGE_PREFIX.len();
    let market = read_pubkey(data, &mut offset)?;
    let owner = read_pubkey(data, &mut offset)?;
    let signer = read_pubkey(data, &mut offset)?;
    let side = read_u8(data, &mut offset)?;
    let outcome = read_u8(data, &mut offset)?;
    let order_type = read_u8(data, &mut offset)?;
    let price = read_u64(data, &mut offset)?;
    let size = read_u64(data, &mut offset)?;
    let expiry_ts = read_i64(data, &mut offset)?;
    let client_order_id = read_u64(data, &mut offset)?;

    Ok(ParsedOrderMessage {
        market,
        owner,
        signer,
        side,
        outcome,
        order_type,
        price,
        size,
        expiry_ts,
        client_order_id,
    })
}

fn parse_order_message_text(data: &[u8]) -> Result<ParsedOrderMessage> {
    let text = std::str::from_utf8(data).map_err(|_| error!(DegenError::InvalidSignature))?;
    let mut lines = text.lines();

    require!(
        lines.next() == Some("DT_ORDER_V1"),
        DegenError::InvalidSignature
    );

    let market = parse_grant_pubkey_line(lines.next(), "market=")?;
    let owner = parse_grant_pubkey_line(lines.next(), "owner=")?;
    let signer = parse_grant_pubkey_line(lines.next(), "signer=")?;
    let side = parse_order_side_line(lines.next(), "side=")?;
    let outcome = parse_order_outcome_line(lines.next(), "outcome=")?;
    let order_type = parse_order_type_line(lines.next(), "order_type=")?;
    let price = parse_order_u64_line(lines.next(), "price=")?;
    let size = parse_order_u64_line(lines.next(), "size=")?;
    let expiry_ts = parse_grant_i64_line(lines.next(), "expiry_ts=")?;
    let client_order_id = parse_order_u64_line(lines.next(), "client_order_id=")?;

    require!(lines.next().is_none(), DegenError::InvalidSignature);

    Ok(ParsedOrderMessage {
        market,
        owner,
        signer,
        side,
        outcome,
        order_type,
        price,
        size,
        expiry_ts,
        client_order_id,
    })
}

fn parse_order_side_line(line: Option<&str>, prefix: &str) -> Result<u8> {
    let value = line
        .and_then(|line| line.strip_prefix(prefix))
        .ok_or_else(|| error!(DegenError::InvalidSignature))?;
    match value {
        "BID" => Ok(0),
        "ASK" => Ok(1),
        _ => err!(DegenError::InvalidSignature),
    }
}

fn parse_order_outcome_line(line: Option<&str>, prefix: &str) -> Result<u8> {
    let value = line
        .and_then(|line| line.strip_prefix(prefix))
        .ok_or_else(|| error!(DegenError::InvalidSignature))?;
    match value {
        "YES" => Ok(0),
        "NO" => Ok(1),
        _ => err!(DegenError::InvalidSignature),
    }
}

fn parse_order_type_line(line: Option<&str>, prefix: &str) -> Result<u8> {
    let value = line
        .and_then(|line| line.strip_prefix(prefix))
        .ok_or_else(|| error!(DegenError::InvalidSignature))?;
    match value {
        "LIMIT" => Ok(0),
        "MARKET" => Ok(1),
        "IOC" => Ok(2),
        "FOK" => Ok(3),
        _ => err!(DegenError::InvalidSignature),
    }
}

fn parse_order_u64_line(line: Option<&str>, prefix: &str) -> Result<u64> {
    let value = line
        .and_then(|line| line.strip_prefix(prefix))
        .ok_or_else(|| error!(DegenError::InvalidSignature))?;
    value.parse::<u64>().map_err(|_| error!(DegenError::InvalidSignature))
}

fn build_order_context_bytes(
    market: &Pubkey,
    order_owner: &Pubkey,
    signer: &Pubkey,
    args: &PlaceOrderArgs,
) -> Vec<u8> {
    let mut message = Vec::with_capacity(ORDER_MESSAGE_PREFIX.len() + 99);
    message.extend_from_slice(ORDER_MESSAGE_PREFIX);
    message.extend_from_slice(market.as_ref());
    message.extend_from_slice(order_owner.as_ref());
    message.extend_from_slice(signer.as_ref());
    message.push(args.side as u8);
    message.push(args.outcome as u8);
    message.push(args.order_type as u8);
    message
}

fn to_lower_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}

fn parse_session_grant_message(data: &[u8]) -> Result<ParsedSessionGrantMessage> {
    let text = std::str::from_utf8(data).map_err(|_| error!(DegenError::InvalidSignature))?;
    let mut lines = text.lines();

    require!(
        lines.next() == Some("DT_SESSION_GRANT_V1"),
        DegenError::InvalidSignature
    );

    let program_id = parse_grant_pubkey_line(lines.next(), "program_id=")?;
    let wallet = parse_grant_pubkey_line(lines.next(), "wallet=")?;
    let session_pubkey = parse_grant_pubkey_line(lines.next(), "session_pubkey=")?;
    let session_authority = parse_grant_pubkey_line(lines.next(), "session_authority=")?;
    let expires_at = parse_grant_i64_line(lines.next(), "expires_at=")?;

    require!(lines.next().is_none(), DegenError::InvalidSignature);

    Ok(ParsedSessionGrantMessage {
        program_id,
        wallet,
        session_pubkey,
        session_authority,
        expires_at,
    })
}

fn parse_grant_pubkey_line(line: Option<&str>, prefix: &str) -> Result<Pubkey> {
    let value = line
        .and_then(|line| line.strip_prefix(prefix))
        .ok_or_else(|| error!(DegenError::InvalidSignature))?;
    Pubkey::from_str(value).map_err(|_| error!(DegenError::InvalidSignature))
}

fn parse_grant_i64_line(line: Option<&str>, prefix: &str) -> Result<i64> {
    let value = line
        .and_then(|line| line.strip_prefix(prefix))
        .ok_or_else(|| error!(DegenError::InvalidSignature))?;
    value.parse::<i64>().map_err(|_| error!(DegenError::InvalidSignature))
}

fn read_u16(data: &[u8], offset: usize) -> Result<u16> {
    let end = offset.checked_add(2).ok_or(DegenError::MathOverflow)?;
    require!(data.len() >= end, DegenError::InvalidSignature);
    Ok(u16::from_le_bytes([data[offset], data[offset + 1]]))
}

fn read_pubkey(data: &[u8], offset: &mut usize) -> Result<Pubkey> {
    let end = offset.checked_add(32).ok_or(DegenError::MathOverflow)?;
    require!(data.len() >= end, DegenError::InvalidSignature);
    let pubkey = Pubkey::new_from_array(
        data[*offset..end]
            .try_into()
            .map_err(|_| error!(DegenError::InvalidSignature))?,
    );
    *offset = end;
    Ok(pubkey)
}

fn read_u8(data: &[u8], offset: &mut usize) -> Result<u8> {
    let end = offset.checked_add(1).ok_or(DegenError::MathOverflow)?;
    require!(data.len() >= end, DegenError::InvalidSignature);
    let value = data[*offset];
    *offset = end;
    Ok(value)
}

fn read_u64(data: &[u8], offset: &mut usize) -> Result<u64> {
    let end = offset.checked_add(8).ok_or(DegenError::MathOverflow)?;
    require!(data.len() >= end, DegenError::InvalidSignature);
    let value = u64::from_le_bytes(
        data[*offset..end]
            .try_into()
            .map_err(|_| error!(DegenError::InvalidSignature))?,
    );
    *offset = end;
    Ok(value)
}

fn read_i64(data: &[u8], offset: &mut usize) -> Result<i64> {
    let end = offset.checked_add(8).ok_or(DegenError::MathOverflow)?;
    require!(data.len() >= end, DegenError::InvalidSignature);
    let value = i64::from_le_bytes(
        data[*offset..end]
            .try_into()
            .map_err(|_| error!(DegenError::InvalidSignature))?,
    );
    *offset = end;
    Ok(value)
}
