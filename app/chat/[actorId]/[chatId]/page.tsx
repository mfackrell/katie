import ChatInterface from '@/components/ChatInterface';

export default async function ChatPage({
  params,
}: {
  params: Promise<{ actorId: string; chatId: string }>;
}) {
  const { actorId, chatId } = await params;

  return <ChatInterface actorId={actorId} chatId={chatId} />;
}
