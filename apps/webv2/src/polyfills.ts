import { Buffer } from 'buffer';

// Polyfill Buffer for browser compatibility with Solana libraries
window.Buffer = window.Buffer || Buffer;
globalThis.Buffer = globalThis.Buffer || Buffer;
