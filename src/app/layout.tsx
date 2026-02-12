import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: 'Remote Terminal',
    description: 'Access your local shell from anywhere',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
