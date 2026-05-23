import 'server-only';
import { StackServerApp } from '@stackframe/stack';
import { loadServerEnv } from '@/lib/env';

const env = loadServerEnv();

export const stackServerApp = new StackServerApp({
  projectId: env.NEXT_PUBLIC_STACK_PROJECT_ID,
  publishableClientKey: env.NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY,
  secretServerKey: env.STACK_SECRET_SERVER_KEY,
  tokenStore: 'nextjs-cookie',
  urls: {
    signIn: '/handler/signin',
    signUp: '/handler/signup',
    afterSignIn: '/watchlist',
    afterSignUp: '/watchlist',
    afterSignOut: '/'
  }
});
