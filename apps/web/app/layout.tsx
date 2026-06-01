import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SyncScribe",
  description: "Collaborative Markdown editor with realtime sharing and history.",
};

// Inlined no-flash theme bootstrap. Runs before React hydrates so the page
// renders directly in the user's stored theme without a light→dark flicker.
const themeBootstrap = `
(function(){try{
  var v = localStorage.getItem('ss_theme') || 'system';
  var resolved = v === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : v;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  document.documentElement.dataset.theme = resolved;
}catch(e){}})();
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
