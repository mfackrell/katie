export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-zinc-900 text-zinc-100 flex h-screen overflow-hidden antialiased">
        {/* The Sidebar Component we built earlier goes here */}
        <Sidebar />
        <main className="flex-1 flex flex-col min-w-0 relative">
          {children}
        </main>
      </body>
    </html>
  );
}
