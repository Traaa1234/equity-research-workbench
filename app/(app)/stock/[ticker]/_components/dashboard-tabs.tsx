import Link from 'next/link';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

export type DashboardTab =
  | 'overview'
  | 'financials'
  | 'technical'
  | 'news'
  | 'filings'
  | 'quality'
  | 'ask';

interface Props {
  ticker: string;
  active: DashboardTab;
}

const TABS: Array<{ value: DashboardTab; label: string; href: (t: string) => string }> = [
  { value: 'overview',   label: 'Overview',   href: (t) => `/stock/${t}` },
  { value: 'financials', label: 'Financials', href: (t) => `/stock/${t}/financials` },
  { value: 'technical',  label: 'Technical',  href: (t) => `/stock/${t}/technical` },
  { value: 'news',       label: 'News',       href: (t) => `/stock/${t}/news` },
  { value: 'filings',    label: 'Filings',    href: (t) => `/stock/${t}/filings` },
  { value: 'quality',    label: 'Quality',    href: (t) => `/stock/${t}/quality` },
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
