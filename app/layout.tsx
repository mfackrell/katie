import './globals.css';
import Sidebar from '@/components/Sidebar';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <link
          rel="stylesheet"
          href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css"
        />
      </head>
      <body className="bg-zinc-950 text-zinc-100 flex h-screen overflow-hidden antialiased">
        <Sidebar />
        <main className="flex-1 flex flex-col min-w-0 relative">{children}</main>
      </body>
    </html>
  );
}
