<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Polyglot Orchestrator</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
</head>
<body class="bg-zinc-900 text-zinc-100 font-sans">

    <div class="flex h-screen overflow-hidden">
        
        <aside class="w-72 bg-zinc-950 flex flex-col border-r border-zinc-800">
            <div class="p-4">
                <button class="w-full flex items-center justify-center gap-2 py-2 px-4 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg transition-all text-sm font-medium">
                    <i class="fa-solid fa-plus text-xs"></i> New Actor
                </button>
            </div>

            <nav class="flex-1 overflow-y-auto px-2 space-y-4">
                
                <div>
                    <div class="flex items-center justify-between px-2 py-1 text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                        <span><i class="fa-solid fa-palette mr-2"></i> Web Designer</span>
                        <i class="fa-solid fa-chevron-down cursor-pointer"></i>
                    </div>
                    <div class="mt-1 space-y-1">
                        <button class="w-full text-left px-3 py-2 text-sm rounded-md bg-zinc-800/50 border-l-2 border-blue-500 text-white truncate">
                            Dashboard UI Layout
                        </button>
                        <button class="w-full text-left px-3 py-2 text-sm rounded-md hover:bg-zinc-900 text-zinc-400 truncate transition-colors">
                            Color Palette Ideas
                        </button>
                    </div>
                </div>

                <div>
                    <div class="flex items-center justify-between px-2 py-1 text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                        <span><i class="fa-solid fa-code mr-2"></i> Python Coder</span>
                        <i class="fa-solid fa-chevron-right cursor-pointer"></i>
                    </div>
                </div>

                <div>
                    <div class="flex items-center justify-between px-2 py-1 text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                        <span><i class="fa-solid fa-chart-line mr-2"></i> CFO Strategy</span>
                        <i class="fa-solid fa-chevron-right cursor-pointer"></i>
                    </div>
                </div>

            </nav>

            <div class="p-4 border-t border-zinc-800 flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold">MF</div>
                <div class="flex-1 overflow-hidden">
                    <p class="text-sm font-medium truncate">Mark Fackrell</p>
                    <p class="text-xs text-zinc-500 truncate">Settings</p>
                </div>
            </div>
        </aside>

        <main class="flex-1 flex flex-col relative">
            
            <header class="h-14 border-b border-zinc-800 flex items-center justify-between px-6 bg-zinc-900/50 backdrop-blur-md">
                <div class="flex items-center gap-4">
                    <h2 class="text-sm font-semibold text-zinc-300">Web Designer <span class="text-zinc-600 mx-2">/</span> <span class="text-white">Dashboard UI Layout</span></h2>
                </div>

                <div class="flex items-center gap-2 px-3 py-1 bg-zinc-800 rounded-full border border-zinc-700">
                    <div class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                    <span class="text-[10px] font-mono text-zinc-400 uppercase tracking-widest">Master Routing: GPT-4o Active</span>
                </div>
            </header>

            <div class="flex-1 overflow-y-auto p-6 space-y-8 max-w-4xl mx-auto w-full">
                
                <div class="flex gap-4">
                    <div class="w-8 h-8 shrink-0 rounded-md bg-zinc-700 flex items-center justify-center text-xs font-bold">MF</div>
                    <div class="space-y-2">
                        <p class="text-sm leading-relaxed">I need to design a clean sidebar for a real estate dashboard. It should support nested menus for different properties.</p>
                    </div>
                </div>

                <div class="flex gap-4">
                    <div class="w-8 h-8 shrink-0 rounded-md bg-blue-600 flex items-center justify-center">
                        <i class="fa-solid fa-bolt text-xs text-white"></i>
                    </div>
                    <div class="space-y-4 flex-1">
                        <p class="text-sm leading-relaxed text-zinc-300">That sounds like a structured UI challenge. Based on your <strong>Permanent Memory</strong> as a Web Designer, I'll prioritize a mobile-first, collapsible approach. </p>
                        <div class="p-4 bg-zinc-950 rounded-lg border border-zinc-800 font-mono text-xs text-blue-400">
                            // Using Tailwind for a clean nested structure... <br>
                            &lt;nav class="space-y-1"&gt; ... &lt;/nav&gt;
                        </div>
                        <div class="flex items-center gap-2 text-[10px] text-zinc-500 uppercase font-bold">
                            <i class="fa-solid fa-microchip"></i> Generated via Gemini 1.5 Pro
                        </div>
                    </div>
                </div>

            </div>

            <div class="p-4 bg-zinc-900">
                <div class="max-w-3xl mx-auto relative">
                    
                    <div class="absolute -top-8 left-0 text-[10px] text-zinc-500 italic">
                        Type <span class="text-zinc-300">"/gpt4"</span> or <span class="text-zinc-300">"/gemini"</span> to override the Master Router.
                    </div>

                    <div class="relative flex items-end bg-zinc-800 border border-zinc-700 rounded-2xl shadow-xl focus-within:border-zinc-500 transition-all">
                        <textarea 
                            rows="1" 
                            placeholder="Ask anything..." 
                            class="w-full bg-transparent border-none focus:ring-0 py-4 px-4 text-sm resize-none"
                        ></textarea>
                        <div class="flex gap-2 p-3">
                            <button class="p-2 text-zinc-400 hover:text-white transition-colors">
                                <i class="fa-solid fa-paperclip"></i>
                            </button>
                            <button class="p-2 bg-white text-black rounded-xl hover:bg-zinc-200 transition-colors">
                                <i class="fa-solid fa-arrow-up"></i>
                            </button>
                        </div>
                    </div>
                    <p class="text-[10px] text-center text-zinc-600 mt-3 uppercase tracking-tighter">
                        Tri-Layer Memory Active: Permanent | Intermediary | Ephemeral
                    </p>
                </div>
            </div>

        </main>
    </div>

</body>
</html>
