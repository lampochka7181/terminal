import type { Metadata } from 'next';
import { Space_Grotesk, IBM_Plex_Mono, Outfit } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

// Primary heading font - geometric and bold
const spaceGrotesk = Space_Grotesk({ 
  subsets: ['latin'],
  variable: '--font-display',
  weight: ['400', '500', '600', '700'],
});

// Body font - clean and modern
const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-sans',
  weight: ['300', '400', '500', '600', '700'],
});

// Monospace font - for prices and numbers
const ibmPlexMono = IBM_Plex_Mono({ 
  subsets: ['latin'],
  variable: '--font-mono',
  weight: ['400', '500', '600', '700'],
});

export const metadata: Metadata = {
  title: 'Degen Terminal | Binary Options Trading',
  description: 'Trade binary outcome markets on BTC, ETH, and SOL',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${outfit.variable} ${ibmPlexMono.variable}`}>
      <body className="bg-background text-text-primary antialiased font-sans">
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
