import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Cherry Trader",
  description: "Local BTCUSDT trading app",
  icons: {
    icon: [{ url: "/icon.png?v=2", type: "image/png" }],
    shortcut: ["/icon.png?v=2"],
    apple: [{ url: "/icon.png?v=2", type: "image/png" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
