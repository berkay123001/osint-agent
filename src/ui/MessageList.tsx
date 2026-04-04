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
    <Box flexDirection="column" marginBottom={1}>
      {visible.map((msg, i) => {
        const content = (msg.content as string).trim();
        if (msg.role === 'user') {
          return (
            <Box key={i} marginTop={1}>
              <Text bold color="green">❯ </Text>
              <Text>{content}</Text>
            </Box>
          );
        }
        // assistant — son 2 mesajı geniş, öncekiler kısa
        const isRecent = i >= visible.length - 2;
        const maxLen = isRecent ? 1500 : 400;
        const text =
          content.length > maxLen
            ? content.slice(0, maxLen) + ` …[+${content.length - maxLen} karakter]`
            : content;
        return (
          <Box key={i} marginLeft={2}>
            <Text dimColor>🤖 </Text>
            <Text dimColor={!isRecent}>{text}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
