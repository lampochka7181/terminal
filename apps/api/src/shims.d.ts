// TEMP SHIMS (dev only)
// We keep these minimal to avoid requiring a full dependency reinstall in dev environments.
// Runtime dependencies still come from node_modules; these are only to satisfy TypeScript.

declare module '@solana/web3.js';
declare module '@solana/spl-token';
declare module '@coral-xyz/anchor';
declare module 'tweetnacl';
declare module 'bs58';
declare module 'crypto';
declare module 'ws';

declare const process: any;
declare const Buffer: any;
declare const TextEncoder: any;
declare function setInterval(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): any;
declare function clearInterval(handle?: any): void;

declare namespace NodeJS {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface Timeout {}
}


