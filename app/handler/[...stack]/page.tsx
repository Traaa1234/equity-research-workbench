import { StackHandler } from '@stackframe/stack';
import { stackServerApp } from '@/stack';

export default function Handler(props: {
  params: { stack: string[] };
  searchParams: Record<string, string | string[] | undefined>;
}) {
  return <StackHandler fullPage app={stackServerApp} routeProps={props} />;
}
