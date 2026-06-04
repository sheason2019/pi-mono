import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "D-Pi Agent Teams",
  tagline: "轻松编排具有你个人特色的 Agent 团队",
  favicon: "img/favicon.ico",

  url: "http://localhost:3000",
  baseUrl: "/",

  organizationName: "sheason2019",
  projectName: "pi-mono",

  onBrokenLinks: "throw",
  onBrokenMarkdownLinks: "throw",

  i18n: {
    defaultLocale: "zh-CN",
    locales: ["zh-CN"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          routeBasePath: "/",
          versions: {
            current: { label: "0.6 (current)" },
          },
        },
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/social-card.png",
    colorMode: {
      defaultMode: "light",
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: "D-Pi Agent Teams",
      logo: {
        alt: "D-Pi",
        src: "img/logo.svg",
      },
      items: [
        { type: "docsVersionDropdown", position: "right" },
        {
          href: "https://github.com/sheason2019/pi-mono",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "文档",
          items: [
            { label: "快速上手", to: "/getting-started/install" },
            { label: "多 Agent 编排", to: "/multi-agent/overview" },
          ],
        },
        {
          title: "项目",
          items: [
            { label: "GitHub", href: "https://github.com/sheason2019/pi-mono" },
            { label: "上游 pi", href: "https://github.com/earendil-works/pi-mono" },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} d-pi contributors. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "json"],
    },
  } satisfies Preset.ThemeConfig,

  themes: [
    [
      require.resolve("@easyops-cn/docusaurus-search-local"),
      {
        hashed: true,
        indexDocs: true,
        indexBlog: false,
        indexPages: true,
        docsRouteBasePath: "/",
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],
};

export default config;
