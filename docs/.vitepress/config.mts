import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Relay',
  description: 'OpenAI/Anthropic-compatible gateway for local model servers',
  base: '/relay/',
  themeConfig: {
    nav: [
      { text: 'Docs', link: '/' },
      { text: 'GitHub', link: 'https://github.com/achuthanmukundan00/relay' },
    ],
    sidebar: [
      { text: 'Overview', items: [{ text: 'Introduction', link: '/' }] },
      {
        text: 'Guides',
        items: [
          { text: 'Quickstart', link: '/quickstart' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'API Compatibility', link: '/api-compatibility' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
        ],
      },
      {
        text: 'Operations',
        items: [
          { text: 'Systemd Deployment', link: '/systemd' },
          { text: 'Architecture', link: '/architecture' },
          { text: 'Agents', link: '/agents' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/achuthanmukundan00/relay' }],
  },
});
