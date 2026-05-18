// ==================== PHP CONSOLE ADAPTER ====================
// Binds the PHP-flavored console card. The engine (terminal_engine.js) owns
// streaming, composer, history, snippet wiring; this file just declares what
// makes "PHP" different from "Shell" or future languages.

Terminal.bind({
  id: 'php',
  displayName: 'PHP',
  prompt: 'php>',
  contPrompt: '...',
  hintsLabel: 'snippets',

  snippets: window.TERMINAL_SNIPPETS?.php || [],

  outputEl: 'console-output',
  inputEl: 'console-input',
  snippetEl: 'snippet-buttons',
  downloadPrefix: 'php-console',

  historyMarker: '',
  excludeMarkers: ['$ '],

  runAction: 'eval',
  codeField: 'code',
  timeoutField: 'timeout',
  timeoutValue: '30',
});
