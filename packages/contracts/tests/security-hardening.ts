import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
} from "@solana/spl-token";
import {
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { expect } from "chai";
import BN from "bn.js";

describe("security-hardening", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.DegenTerminal as Program<any>;

  let admin: Keypair;
  let feeRecipient: Keypair;
  let authority: Keypair;
  let attacker: Keypair;
  let usdcMint: PublicKey;
  let fakeUsdcMint: PublicKey;
  let globalStatePda: PublicKey;

  before(async () => {
    admin = Keypair.generate();
    feeRecipient = Keypair.generate();
    authority = Keypair.generate();
    attacker = Keypair.generate();

    for (const kp of [admin, feeRecipient, authority, attacker]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    [globalStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global")],
      program.programId
    );

    await program.methods
      .initializeGlobal(0, 10)
      .accounts({
        globalState: globalStatePda,
        admin: admin.publicKey,
        feeRecipient: feeRecipient.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    usdcMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    fakeUsdcMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );
  });

  function deriveMarketPda(asset: string, timeframe: string, expiryTs: BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("market"),
        Buffer.from(asset),
        Buffer.from(timeframe),
        expiryTs.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];
  }

  function deriveMarketV2Pda(asset: string, timeframe: string, expiryTs: BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("market_v2"),
        Buffer.from(asset),
        Buffer.from(timeframe),
        expiryTs.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];
  }

  function deriveSessionAuthorityPda(wallet: PublicKey, sessionPubkey: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("session_authority"),
        wallet.toBuffer(),
        sessionPubkey.toBuffer(),
      ],
      program.programId
    )[0];
  }

  function buildSessionGrantMessage(
    wallet: PublicKey,
    sessionPubkey: PublicKey,
    sessionAuthority: PublicKey,
    expiresAt: BN,
    programId: PublicKey = program.programId
  ): Buffer {
    return Buffer.from(
      [
        "DT_SESSION_GRANT_V1",
        `program_id=${programId.toBase58()}`,
        `wallet=${wallet.toBase58()}`,
        `session_pubkey=${sessionPubkey.toBase58()}`,
        `session_authority=${sessionAuthority.toBase58()}`,
        `expires_at=${expiresAt.toString()}`,
      ].join("\n"),
      "utf8"
    );
  }

  describe("canonical collateral binding", () => {
    it("stores canonical usdc mint and vault on V1 markets", async () => {
      const expiryTs = new BN(Math.floor(Date.now() / 1000) + 300);
      const marketPda = deriveMarketPda("BTC", "5m", expiryTs);
      const vault = await anchor.utils.token.associatedAddress({
        mint: usdcMint,
        owner: marketPda,
      });

      await program.methods
        .initializeMarket("BTC", "5m", new BN(100_000_000), expiryTs)
        .accounts({
          globalState: globalStatePda,
          market: marketPda,
          vault,
          usdcMint,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      const market = await program.account.market.fetch(marketPda);
      expect(market.usdcMint.toBase58()).to.equal(usdcMint.toBase58());
      expect(market.vault.toBase58()).to.equal(vault.toBase58());
    });
  });

  describe("v2 finalize hardening", () => {
    it("rejects non-authority callers during phase 2 finalize", async () => {
      const expiryTs = new BN(Math.floor(Date.now() / 1000) + 600);
      const market = deriveMarketV2Pda("ETH", "1m", expiryTs);
      const yesMint = PublicKey.findProgramAddressSync(
        [Buffer.from("yes_mint"), market.toBuffer()],
        program.programId
      )[0];
      const noMint = PublicKey.findProgramAddressSync(
        [Buffer.from("no_mint"), market.toBuffer()],
        program.programId
      )[0];
      const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), market.toBuffer()],
        program.programId
      );

      await program.methods
        .initializeMarketV2("ETH", "1m", new BN(0), expiryTs)
        .accounts({
          market,
          yesMint,
          authority: authority.publicKey,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          shareTokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      try {
        await program.methods
          .initializeMarketV2Finalize(new BN(0))
          .accounts({
            market,
            noMint,
            usdcMint,
            vault,
            authority: attacker.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            shareTokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([attacker])
          .rpc();
        expect.fail("expected unauthorized finalize to fail");
      } catch (err: any) {
        expect(err.error?.errorCode?.code || err.message).to.satisfy(
          (msg: string) => msg.includes("Unauthorized") || msg.includes("unauthorized")
        );
      }
    });

    it("rejects a mismatched 6-decimal collateral mint during finalize", async () => {
      const expiryTs = new BN(Math.floor(Date.now() / 1000) + 900);
      const market = deriveMarketV2Pda("SOL", "15m", expiryTs);
      const yesMint = PublicKey.findProgramAddressSync(
        [Buffer.from("yes_mint"), market.toBuffer()],
        program.programId
      )[0];
      const noMint = PublicKey.findProgramAddressSync(
        [Buffer.from("no_mint"), market.toBuffer()],
        program.programId
      )[0];
      const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), market.toBuffer()],
        program.programId
      );

      await program.methods
        .initializeMarketV2("SOL", "15m", new BN(0), expiryTs)
        .accounts({
          market,
          yesMint,
          authority: authority.publicKey,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          shareTokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      try {
        await program.methods
          .initializeMarketV2Finalize(new BN(0))
          .accounts({
            market,
            noMint,
            usdcMint: fakeUsdcMint,
            vault,
            authority: authority.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            shareTokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([authority])
          .rpc();
        expect.fail("expected mismatched mint finalize to fail");
      } catch (err: any) {
        expect(err.error?.errorCode?.code || err.message).to.satisfy(
          (msg: string) => msg.includes("InvalidMarketParams") || msg.includes("constraint")
        );
      }
    });
  });

  describe("session authority", () => {
    it("creates and revokes a session authority PDA", async () => {
      const sessionSigner = Keypair.generate();
      const expiresAt = new BN(Math.floor(Date.now() / 1000) + 3600);
      const sessionAuthority = deriveSessionAuthorityPda(authority.publicKey, sessionSigner.publicKey);

      await program.methods
        .createSessionAuthority(sessionSigner.publicKey, expiresAt)
        .accounts({
          sessionAuthority,
          user: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      const created = await program.account.sessionAuthority.fetch(sessionAuthority);
      expect(created.wallet.toBase58()).to.equal(authority.publicKey.toBase58());
      expect(created.sessionPubkey.toBase58()).to.equal(sessionSigner.publicKey.toBase58());
      expect(created.revoked).to.equal(false);

      await program.methods
        .revokeSessionAuthority()
        .accounts({
          sessionAuthority,
          wallet: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      const revoked = await program.account.sessionAuthority.fetch(sessionAuthority);
      expect(revoked.revoked).to.equal(true);
    });

    it("rejects session registrations longer than seven days", async () => {
      const sessionSigner = Keypair.generate();
      const expiresAt = new BN(Math.floor(Date.now() / 1000) + 8 * 24 * 60 * 60);
      const sessionAuthority = deriveSessionAuthorityPda(authority.publicKey, sessionSigner.publicKey);

      try {
        await program.methods
          .createSessionAuthority(sessionSigner.publicKey, expiresAt)
          .accounts({
            sessionAuthority,
            user: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([authority])
          .rpc();
        expect.fail("expected overly long session duration to fail");
      } catch (err: any) {
        expect(err.error?.errorCode?.code || err.message).to.satisfy(
          (msg: string) => msg.includes("InvalidSessionDuration") || msg.includes("invalid session duration")
        );
      }
    });

    it("creates a session authority PDA via relayed wallet signature", async () => {
      const sessionSigner = Keypair.generate();
      const payer = Keypair.generate();
      const expiresAt = new BN(Math.floor(Date.now() / 1000) + 3600);
      const sessionAuthority = deriveSessionAuthorityPda(authority.publicKey, sessionSigner.publicKey);
      const message = buildSessionGrantMessage(
        authority.publicKey,
        sessionSigner.publicKey,
        sessionAuthority,
        expiresAt
      );
      const verifyIx = Ed25519Program.createInstructionWithPrivateKey({
        privateKey: authority.secretKey,
        message,
      });

      const sig = await provider.connection.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);

      await program.methods
        .createSessionAuthorityBySig(sessionSigner.publicKey, expiresAt)
        .accounts({
          sessionAuthority,
          user: authority.publicKey,
          payer: payer.publicKey,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([verifyIx])
        .signers([payer])
        .rpc();

      const created = await program.account.sessionAuthority.fetch(sessionAuthority);
      expect(created.wallet.toBase58()).to.equal(authority.publicKey.toBase58());
      expect(created.sessionPubkey.toBase58()).to.equal(sessionSigner.publicKey.toBase58());
      expect(created.revoked).to.equal(false);
    });

    it("rejects relayed session grants for the wrong program id", async () => {
      const sessionSigner = Keypair.generate();
      const payer = Keypair.generate();
      const expiresAt = new BN(Math.floor(Date.now() / 1000) + 3600);
      const sessionAuthority = deriveSessionAuthorityPda(authority.publicKey, sessionSigner.publicKey);
      const message = buildSessionGrantMessage(
        authority.publicKey,
        sessionSigner.publicKey,
        sessionAuthority,
        expiresAt,
        SystemProgram.programId
      );
      const verifyIx = Ed25519Program.createInstructionWithPrivateKey({
        privateKey: authority.secretKey,
        message,
      });

      const sig = await provider.connection.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);

      try {
        await program.methods
          .createSessionAuthorityBySig(sessionSigner.publicKey, expiresAt)
          .accounts({
            sessionAuthority,
            user: authority.publicKey,
            payer: payer.publicKey,
            instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([verifyIx])
          .signers([payer])
          .rpc();
        expect.fail("expected invalid relayed session grant to fail");
      } catch (err: any) {
        expect(err.error?.errorCode?.code || err.message).to.satisfy(
          (msg: string) => msg.includes("InvalidSignature") || msg.includes("invalid signature")
        );
      }
    });

    it("rejects replaying the same relayed session grant", async () => {
      const sessionSigner = Keypair.generate();
      const payer = Keypair.generate();
      const expiresAt = new BN(Math.floor(Date.now() / 1000) + 3600);
      const sessionAuthority = deriveSessionAuthorityPda(authority.publicKey, sessionSigner.publicKey);
      const message = buildSessionGrantMessage(
        authority.publicKey,
        sessionSigner.publicKey,
        sessionAuthority,
        expiresAt
      );
      const verifyIx = Ed25519Program.createInstructionWithPrivateKey({
        privateKey: authority.secretKey,
        message,
      });

      const sig = await provider.connection.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);

      await program.methods
        .createSessionAuthorityBySig(sessionSigner.publicKey, expiresAt)
        .accounts({
          sessionAuthority,
          user: authority.publicKey,
          payer: payer.publicKey,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([verifyIx])
        .signers([payer])
        .rpc();

      const replayVerifyIx = Ed25519Program.createInstructionWithPrivateKey({
        privateKey: authority.secretKey,
        message,
      });

      try {
        await program.methods
          .createSessionAuthorityBySig(sessionSigner.publicKey, expiresAt)
          .accounts({
            sessionAuthority,
            user: authority.publicKey,
            payer: payer.publicKey,
            instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([replayVerifyIx])
          .signers([payer])
          .rpc();
        expect.fail("expected replayed relayed session grant to fail");
      } catch (err: any) {
        expect(err.error?.errorCode?.code || err.message).to.satisfy(
          (msg: string) => msg.includes("already in use") || msg.includes("Allocate") || msg.includes("custom program error")
        );
      }
    });
  });
});
