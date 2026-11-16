"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { remarkCurrencyProse } from "@/lib/chat/markdown-currency";
import { ownerSessionBearer } from "@/lib/tools/browser-owner-session";
import { resolveDocumentDownload } from "@/lib/documents/client-download";
import { useState, type ReactNode } from "react";

/** A normal browser link cannot attach the owner token kept in Supabase's
 * browser session. Fetch the private file with verified owner/guest credentials,
 * then download the returned bytes; never leak a token in the link or URL. */
function PrivateDocumentLink({href,children}:{href:string;children:ReactNode}) {
  const [pending,setPending]=useState(false);
  const [error,setError]=useState("");
  async function download(){
    if(pending)return;
    const target=resolveDocumentDownload(href,window.location.origin);
    if(!target){setError("Invalid document link.");return;}
    setPending(true);setError("");
    try{
      const token=await ownerSessionBearer();
      const response=await fetch(target.path,{
        method:"GET",credentials:"same-origin",cache:"no-store",redirect:"error",
        headers:token?{Authorization:"Bearer "+token}:{},
      });
      if(!response.ok||response.headers.get("content-type")?.split(";")[0]!==target.mime)
        throw new Error("Document access denied.");
      const file=await response.blob();
      if(file.size===0||file.size>8_000_000)throw new Error("Invalid document.");
      const url=URL.createObjectURL(file);
      try{
        const anchor=document.createElement("a");
        anchor.href=url;
        anchor.download=target.filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }finally{
        // Permit the browser's download to begin before releasing the object.
        window.setTimeout(()=>URL.revokeObjectURL(url),1000);
      }
    }catch{
      setError("Document unavailable or access denied. Check the conversation's owner session.");
    }finally{setPending(false);}
  }
  return <span>
    <a href={href} aria-busy={pending}
      className="font-medium text-sky-300 underline decoration-sky-400/40 underline-offset-4 transition hover:text-sky-200 hover:decoration-sky-300"
      onClick={event=>{event.preventDefault();void download();}}>{pending?"Downloading…":children}</a>
    {error&&<span role="alert" className="ml-2 text-amber-300">{error}</span>}
  </span>;
}

/** One Markdown renderer for ordinary and interleaved assistant prose. */
export function AssistantMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath, remarkCurrencyProse]}
      rehypePlugins={[rehypeKatex]}
      components={{
        h1: ({ children }) => (
          <h1 className="mb-4 mt-6 text-2xl font-semibold tracking-tight text-white first:mt-0">
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className="mb-3 mt-6 text-xl font-semibold tracking-tight text-white first:mt-0">
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className="mb-2 mt-5 text-base font-semibold text-zinc-100 first:mt-0">
            {children}
          </h3>
        ),
        p: ({ children }) => (
          <p className="my-3 leading-7 first:mt-0 last:mb-0">{children}</p>
        ),
        strong: ({ children }) => (
          <strong className="font-semibold text-white">{children}</strong>
        ),
        em: ({ children }) => <em className="text-zinc-200">{children}</em>,
        ul: ({ children }) => (
          <ul className="my-3 list-disc space-y-1.5 pl-6 marker:text-zinc-500">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="my-3 list-decimal space-y-1.5 pl-6 marker:text-zinc-500">{children}</ol>
        ),
        li: ({ children }) => <li className="pl-1 leading-7">{children}</li>,
        blockquote: ({ children }) => (
          <blockquote className="my-4 border-l-2 border-emerald-400/50 bg-white/[0.025] py-1 pl-4 pr-3 text-zinc-300">
            {children}
          </blockquote>
        ),
        hr: () => <hr className="my-6 border-white/10" />,
        a: ({ href, children }) => href?.startsWith("/api/documents/download?")
          ? <PrivateDocumentLink href={href}>{children}</PrivateDocumentLink>
          : <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-sky-300 underline decoration-sky-400/40 underline-offset-4 transition hover:text-sky-200 hover:decoration-sky-300"
            >
              {children}
            </a>,
        pre: ({ children }) => (
          <pre className="my-4 overflow-x-auto rounded-2xl border border-white/10 bg-black/35 p-4 text-[13px] leading-6 text-zinc-100 shadow-inner">
            {children}
          </pre>
        ),
        code: ({ className, children }) => {
          const isBlock = Boolean(className) || String(children).includes("\n");
          return (
            <code
              className={
                isBlock
                  ? `font-mono ${className ?? ""}`
                  : "rounded-md border border-white/10 bg-white/[0.07] px-1.5 py-0.5 font-mono text-[0.9em] text-zinc-100"
              }
            >
              {children}
            </code>
          );
        },
        table: ({ children }) => (
          <div className="my-4 overflow-x-auto rounded-2xl border border-white/10">
            <table className="w-full border-collapse text-left text-sm">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-white/[0.06] text-zinc-100">{children}</thead>,
        tbody: ({ children }) => <tbody className="divide-y divide-white/10">{children}</tbody>,
        tr: ({ children }) => <tr className="divide-x divide-white/10">{children}</tr>,
        th: ({ children }) => (
          <th className="px-3 py-2.5 font-semibold text-white">{children}</th>
        ),
        td: ({ children }) => <td className="px-3 py-2.5 align-top leading-6">{children}</td>,
        del: ({ children }) => <del className="text-zinc-500">{children}</del>,
        input: ({ node, ...props }) => {
          void node;
          return <input {...props} className="mr-2 accent-emerald-500" disabled />;
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
