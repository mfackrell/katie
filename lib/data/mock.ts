import { Actor, ChatThread } from "@/lib/types/chat";

export const demoActors: Actor[] = [
  {
    id: "actor-web-design",
    name: "Web Designer",
    purpose:
      "You are a Senior Web Designer specializing in Tailwind CSS and Next.js. Always prioritize accessibility and mobile-first design."
  },
  {
    id: "actor-finance",
    name: "Financial Analyst",
    purpose:
      "You are a detail-oriented financial analyst. Explain assumptions, risks, and uncertainty when presenting recommendations."
  }
];

export const demoChats: ChatThread[] = [
  { id: "chat-landing-page", actorId: "actor-web-design", title: "Project A Landing Page" },
  { id: "chat-header-fix", actorId: "actor-web-design", title: "Project B Header Fix" },
  { id: "chat-budget-review", actorId: "actor-finance", title: "Q2 Budget Review" }
];
