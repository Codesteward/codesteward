import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Codesteward Review',
  tagline: 'Agentic code review that knows your graph — self-hosted docs',
  // Official mark from packages/ui/public/brand (copied into static/img)
  favicon: 'img/favicon.ico',

  url: 'https://docs.codesteward.ai',
  baseUrl: '/',

  organizationName: 'codesteward',
  projectName: 'codesteward',

  onBrokenLinks: 'throw',

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  headTags: [
    {
      tagName: 'link',
      attributes: {
        rel: 'icon',
        type: 'image/png',
        sizes: '32x32',
        href: '/img/favicon-32.png',
      },
    },
    {
      tagName: 'link',
      attributes: {
        rel: 'icon',
        type: 'image/png',
        sizes: '64x64',
        href: '/img/favicon-64.png',
      },
    },
    {
      tagName: 'link',
      attributes: {
        rel: 'apple-touch-icon',
        sizes: '180x180',
        href: '/img/apple-touch-icon.png',
      },
    },
  ],

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: 'docs',
          editUrl: undefined,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    // Open Graph / social preview — official logo
    image: 'img/social-card.png',
    metadata: [
      {
        name: 'description',
        content:
          'Self-hosted agentic PR gate and branch stewardship. Install with Compose or Helm. Graph-aware multi-agent code review.',
      },
    ],
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'Codesteward Review',
      logo: {
        alt: 'Codesteward',
        // Official icon (same assets as product UI packages/ui/public/brand)
        src: 'img/brand/codesteward-icon-nav.png',
        srcDark: 'img/brand/codesteward-icon-nav.png',
        width: 32,
        height: 32,
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/docs/getting-started/quickstart',
          label: 'Quick start',
          position: 'left',
        },
        {
          to: '/docs/getting-started/kubernetes',
          label: 'Kubernetes',
          position: 'left',
        },
        {
          to: '/docs/install/overview',
          label: 'Install',
          position: 'left',
        },
        {
          to: '/docs/product/ui-guide',
          label: 'Product',
          position: 'left',
        },
        {
          href: 'https://codesteward.ai',
          label: 'codesteward.ai',
          position: 'right',
        },
        {
          href: 'https://github.com/codesteward/codesteward',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Start',
          items: [
            {label: 'Introduction', to: '/docs/'},
            {label: 'Why Codesteward', to: '/docs/concepts/why-codesteward'},
            {label: 'Compose quick start', to: '/docs/getting-started/quickstart'},
            {label: 'Kubernetes quick start', to: '/docs/getting-started/kubernetes'},
            {label: 'FAQ', to: '/docs/reference/faq'},
          ],
        },
        {
          title: 'Install & configure',
          items: [
            {label: 'Install overview', to: '/docs/install/overview'},
            {label: 'Helm (OCI / GHCR)', to: '/docs/install/helm'},
            {label: 'Identity', to: '/docs/configure/identity'},
            {label: 'Environment', to: '/docs/reference/environment'},
          ],
        },
        {
          title: 'Product & ops',
          items: [
            {label: 'UI guide', to: '/docs/product/ui-guide'},
            {label: 'Pipeline', to: '/docs/pipeline/overview'},
            {label: 'Multi-tenant workers', to: '/docs/ops/multi-tenant-workers'},
            {label: 'Session audit', to: '/docs/security/session-audit'},
          ],
        },
        {
          title: 'Project',
          items: [
            {label: 'codesteward.ai', href: 'https://codesteward.ai'},
            {label: 'GitHub', href: 'https://github.com/codesteward/codesteward'},
            {label: 'Apache-2.0 license', href: 'https://github.com/codesteward/codesteward/blob/main/LICENSE'},
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} bitkaio LLC. Codesteward Review — self-hosted documentation.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'sql', 'yaml'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
