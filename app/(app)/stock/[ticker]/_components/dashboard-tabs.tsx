import Link from 'next/link';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

export type DashboardTab =
  | 'overview'
  | 'journal'
  | 'financials'
  | 'technical'
  | 'news'
  | 'insiders'
  | 'holdings'
  | 'filings'
  | 'quality'
  | 'peers'
  | 'ask';

interface Props {
  ticker: string;
  active: DashboardTab;
}

const TABS: Array<{ value: DashboardTab; label: string; href: (t: string) => string }> = [
  { value: 'overview',   label: 'Overview',   href: (t) => `/stock/${t}` },
  { value: 'journal',    label: 'Journal',    href: (t) => `/stock/${t}/journal` },
  { value: 'financials', label: 'Financials', href: (t) => `/stock/${t}/financials` },
  { value: 'technical',  label: 'Technical',  href: (t) => `/stock/${t}/technical` },
  { value: 'news',       label: 'News',       href: (t) => `/stock/${t}/news` },
  { value: 'insiders',   label: 'Insiders',   href: (t) => `/stock/${t}/insiders` },
  { value: 'holdings',   label: 'Holdings',   href: (t) => `/stock/${t}/holdings` },
  { value: 'filings',    label: 'Filings',    href: (t) => `/stock/${t}/filings` },
  { value: 'quality',    label: 'Quality',    href: (t) => `/stock/${t}/quality` },
  { value: 'peers',      label: 'Peers',      href: (t) => `/stock/${t}/peers` },
  { value: 'ask',        label: 'Ask',        href: (t) => `/stock/${t}/ask` }
];

export function DashboardTabs({ ticker, active }: Props) {
  return (
    <Tabs value={active} className="hidden sm:block">
      <TabsList>
        {TABS.map((t) => (
          <TabsTrigger key={t.value} value={t.value} asChild>
            <Link href={t.href(ticker)}>{t.label}</Link>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
