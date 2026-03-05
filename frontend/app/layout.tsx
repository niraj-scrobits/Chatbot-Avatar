import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
    title: "Avatar POC — WebRTC Latency Evaluation",
    description:
        "Proof-of-concept: Simli WebRTC avatar + Gemini 2.5 Flash voice pipeline targeting sub-800ms latency.",
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
