import type { Metadata } from 'next';
import TerminalClient from './TerminalClient';

export const metadata: Metadata = {
    title: 'Remote Terminal',
    description: 'Remote shell access from anywhere',
};

export default function TerminalPage() {
    return (
        <>
            <link rel="stylesheet" href="/xterm.css" />
            <TerminalClient />
        </>
    );
}
