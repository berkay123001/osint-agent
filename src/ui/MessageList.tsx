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

  let pasteCounter = 0;

  return (
    <Box flexDirection="column">
      {visible.map((msg, i) => {
        const content = (msg.content as string).trim();
        const isUser = msg.role === 'user';

        // Multi-line user message → compact paste format
        if (isUser && content.includes('\n')) {
          pasteCounter++;
          const lines = content.split('\n');
          const firstLine = (lines.find(l => l.trim().length > 0) || lines[0]).trim();
          const preview = firstLine.slice(0, 80);
          const extraLines = lines.length - 1;
          const needsEllipsis = firstLine.length > 80 || extraLines > 0;

          return (
            <Box key={i} flexDirection="column" marginTop={i > 0 ? 1 : 0}>
              <Text bold color="cyan">You</Text>
              <Text dimColor>
                [paste #{pasteCounter} &quot;{preview}{needsEllipsis ? '…' : ''}&quot; +{extraLines} lines]
              </Text>
            </Box>
          );
        }

        // Normal message display
        const text = content;

        return (
          <Box key={i} flexDirection="column" marginTop={i > 0 ? 1 : 0}>
            <Text bold color={isUser ? 'cyan' : 'magenta'}>
              {isUser ? 'You' : 'Agent'}
            </Text>
            <Text>{text}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
