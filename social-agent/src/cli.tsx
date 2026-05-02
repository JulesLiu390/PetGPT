import React from 'react';
import { render, Box, Text } from 'ink';
import { ensureHome, getPaths } from './paths.ts';

const App: React.FC = () => {
  const paths = getPaths();
  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text bold color="cyan">social-agent</Text>
        <Text dimColor> v0.0.1</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>home:      </Text>
        <Text>  {paths.home}</Text>
        <Text dimColor>settings:  </Text>
        <Text>  {paths.settings}</Text>
        <Text dimColor>providers: </Text>
        <Text>  {paths.providers}</Text>
        <Text dimColor>pets:      </Text>
        <Text>  {paths.petsDir}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="yellow">scaffolding only — server / TUI dashboard not yet wired.</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>(Ctrl-C to quit)</Text>
      </Box>
    </Box>
  );
};

ensureHome();
render(<App />);
