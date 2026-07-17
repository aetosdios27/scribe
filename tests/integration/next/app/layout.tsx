import "@scribe/styles/default.css";
import "../../../fixtures/hosts.css";

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="fixture-shell fixture-neutral" data-theme="light">{children}</body>
    </html>
  );
}
