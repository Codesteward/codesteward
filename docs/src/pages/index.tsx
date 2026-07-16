import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

import styles from './index.module.css';

type Card = {title: string; description: string; to: string; cta: string};

const primary: Card[] = [
  {
    title: 'Why self-host graph-aware review?',
    description:
      'Diff-only bots guess. Codesteward pairs multi-agent specialists with a structural code graph — on infrastructure you control.',
    to: '/docs/concepts/why-codesteward',
    cta: 'Read why',
  },
  {
    title: 'Try it in minutes',
    description:
      'Category Compose stack: Postgres, Keycloak, API, worker, UI. No SaaS signup — clone, compose, review.',
    to: '/docs/getting-started/quickstart',
    cta: 'Quick start',
  },
  {
    title: 'Install for production',
    description:
      'Helm chart from GHCR (OCI), horizontal workers, Neo4j/Janus, OIDC, optional KEDA.',
    to: '/docs/getting-started/kubernetes',
    cta: 'Kubernetes / Helm',
  },
];

const secondary: Card[] = [
  {
    title: 'Product UI',
    description: 'Gate, Steward, findings, models, platform ops — with screenshots.',
    to: '/docs/product/ui-guide',
    cta: 'UI guide',
  },
  {
    title: 'How a review works',
    description: 'Units, specialists, discourse, judge, SARIF, and SCM publish.',
    to: '/docs/pipeline/overview',
    cta: 'Pipeline',
  },
  {
    title: 'Multi-tenant ops',
    description: 'Org workspace jails, strict sandbox, org-affine workers.',
    to: '/docs/ops/multi-tenant-workers',
    cta: 'Isolation',
  },
  {
    title: 'Security & audit',
    description: 'Session provenance ledger, crash resume, operator responsibilities.',
    to: '/docs/security/overview',
    cta: 'Security',
  },
];

function Hero() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero', styles.heroBanner)}>
      <div className="container">
        <p className={styles.kicker}>Self-hosted · Apache-2.0 · No SaaS required</p>
        <Heading as="h1" className={clsx('hero__title', styles.heroTitle)}>
          {siteConfig.title}
        </Heading>
        <p className={clsx('hero__subtitle', styles.heroSubtitle)}>{siteConfig.tagline}</p>
        <p className={styles.heroLead}>
          Gate every merge. Steward every branch. Bring your own models, identity, and cloud.
        </p>
        <div className={styles.buttons}>
          <Link className="button button--secondary button--lg" to="/docs/getting-started/quickstart">
            Get started
          </Link>
          <Link className="button button--outline button--lg" to="/docs/">
            Documentation
          </Link>
          <Link className="button button--outline button--lg" to="/docs/concepts/why-codesteward">
            Why Codesteward
          </Link>
        </div>
      </div>
    </header>
  );
}

function CardGrid({items, columns = 3}: {items: Card[]; columns?: 3 | 4}) {
  const col = columns === 4 ? 'col--3' : 'col--4';
  return (
    <div className="row">
      {items.map((c) => (
        <div key={c.to} className={clsx('col', col, styles.featureCard)}>
          <div className={styles.cardInner}>
            <Heading as="h3">{c.title}</Heading>
            <p>{c.description}</p>
            <Link to={c.to}>{c.cta} →</Link>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Home(): ReactNode {
  return (
    <Layout
      title="Documentation"
      description="Self-hosted agentic code review that knows your graph. Install guides, product docs, and operator runbooks.">
      <Hero />
      <main>
        <section className={styles.features}>
          <div className="container">
            <Heading as="h2" className={styles.sectionTitle}>
              Evaluate
            </Heading>
            <CardGrid items={primary} columns={3} />
            <Heading as="h2" className={clsx(styles.sectionTitle, styles.sectionTitleSpaced)}>
              Operate & deepen
            </Heading>
            <CardGrid items={secondary} columns={4} />
            <div className={styles.bannerNote}>
              <strong>Self-hosted only.</strong> There is no multi-tenant Codesteward SaaS today.
              Use these docs to decide whether to install the platform in your environment — then
              follow Compose or Helm when you are ready.
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
