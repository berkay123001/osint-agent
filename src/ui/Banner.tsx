import React from 'react';
import { Box, Text } from 'ink';

export function Header(): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">OSINT Agent</Text>
        <Text dimColor>{' '}· multi-agent intelligence</Text>
      </Box>
    </Box>
  );
}
