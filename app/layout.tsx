import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Income Flywheel Portfolio',
  description: 'Backtest and project an income-focused portfolio flywheel',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
