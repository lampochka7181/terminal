const AVATARS = ['🥷', '🦍', '🐋', '🦊', '🤖', '🎮', '💀', '🔥', '🚀', '👾'];

export function walletAvatar(walletAddress: string): string {
  let hash = 0;
  for (let i = 0; i < walletAddress.length; i++) hash = ((hash << 5) - hash) + walletAddress.charCodeAt(i);
  return AVATARS[Math.abs(hash) % AVATARS.length];
}



