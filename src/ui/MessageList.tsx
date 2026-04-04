import React from 'react';
import { Box, Text } from 'ink';
import type { Message } from '../agents/types.js';

interface Props {
  messages: Message[];
}

export function MessageList({ messages }: Props): React.ReactElement {
  const visible = messages.filter(
    (m) =>
      (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string' &&
      m.content.trim().length > 0,
  );

  if (visible.length === 0) return <></>;

  return (
    <Box flexDirection="column">
      {visible.map((msg, i) => {
        const content = (msg.content as string).trim();
        const isUser = msg.role === 'user';
        const isRecent = i >= visible.length - 2;
        const maxLen = isRecent ? 2000 : 500;
        const text =
          content.length > maxLen
            ? content.slice(0, maxLen) + `\n… [+${content.length - maxLen} karakter]`
            : content;

        return (
          <Box key={i} flexDirection="column" marginTop={i > 0 ? 1 : 0}>
            <Text bold color={isUser ? 'cyan' : 'magenta'}>
              {isUser ? 'You' : 'Agent'}
            </Text>
            <Text dimColor={!isUser && !isRecent}>{text}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
