# Equity Research Workbench — Phase 1B: Auth + API + UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the user-facing layer of Slice 1 — Stack Auth signup/login, gated layout, API routes for data + watchlist + notes, watchlist landing page, ticker dashboard with snapshot card + financials charts, add-ticker flow, notes editor.

**Architecture:** Stack Auth's `@stackframe/stack` SDK provides identity. The Next.js `/handler/[...stack]` catch-all hosts signup/login/account routes. Server-side `stackServerApp.getUser()` resolves the current user; passing that user id into `withUserContext(...)` runs DB queries under RLS. Route handlers wrap services thinly (auth → parse → call service → return). UI is App Router RSC for initial render plus client islands for charts, forms, and the notes editor.

**Tech Stack:** Phase 1A stack (Next.js 14, TS strict, Drizzle, Neon, Stack Auth SDK, Upstash) + Tailwind CSS + shadcn/ui + Recharts + react-markdown editor.


**Important Next.js 14 reminder:** All route handler `params` in this plan are sync. In Next.js 14, `{ params }: { params: { ticker: string } }` (no Promise wrapping, no await). If you upgrade to Next 15 later, this changes to `Promise<{ ticker: string }>` + `await params`.

**Spec reference:** `docs/superpowers/specs/2026-05-23-equity-research-workbench-slice-1-design.md`

**Prior phase:** Phase 1A landed the data layer (45 commits, 93 tests). Services, providers, schema, RLS all in place. This plan picks up at commit `4901bd8` or later.

---

## File Structure for Phase 1B

```
equity-research-workbench/
├── stack.ts                              # Stack Auth server app instance (NEW)
├── tailwind.config.ts                    # Tailwind config (NEW)
├── postcss.config.mjs                    # PostCSS pipeline (NEW)
├── components.json                       # shadcn/ui config (NEW)
├── middleware.ts                         # session middleware (NEW)
├── app/
│   ├── globals.css                       # Tailwind + theme (NEW)
│   ├── layout.tsx                        # root layout with Stack provider (MODIFIED)
│   ├── page.tsx                          # logged-out landing (MODIFIED — simple, real)
│   ├── handler/
│   │   └── [...stack]/page.tsx           # Stack Auth catch-all (NEW)
│   ├── (app)/
│   │   ├── layout.tsx                    # session-gated shell with nav (NEW)
│   │   ├── watchlist/
│   │   │   └── page.tsx                  # watchlist landing (NEW)
│   │   └── stock/[ticker]/
│   │       ├── page.tsx                  # ticker dashboard (NEW)
│   │       ├── loading.tsx               # skeleton (NEW)
│   │       ├── not-found.tsx             # 404 (NEW)
│   │       ├── financials/page.tsx       # financials tab (NEW)
│   │       └── _components/
│   │           ├── snapshot-card.tsx     # client island (NEW)
│   │           ├── sparkline.tsx         # Recharts 1Y price (NEW)
│   │           ├── earnings-card.tsx     # 8Q EPS (NEW)
│   │           ├── notes-editor.tsx      # markdown editor + autosave (NEW)
│   │           ├── financials-table.tsx  # 5Y statements table (NEW)
│   │           ├── revenue-chart.tsx     # Recharts bar (NEW)
│   │           ├── margin-chart.tsx      # Recharts line (NEW)
│   │           ├── fcf-chart.tsx         # Recharts bar (NEW)
│   │           └── add-ticker-dialog.tsx # shadcn dialog (NEW)
│   └── api/
│       ├── tickers/
│       │   ├── add/route.ts              # POST { symbol } (NEW)
│       │   └── [symbol]/
│       │       ├── snapshot/route.ts     # GET (NEW)
│       │       ├── financials/route.ts   # GET ?type&period (NEW)
│       │       └── prices/route.ts       # GET ?range (NEW)
│       ├── watchlist/
│       │   ├── route.ts                  # GET, POST { ticker }, DELETE { ticker } (NEW)
│       │   └── [ticker]/route.ts         # DELETE (NEW)
│       └── notes/[ticker]/route.ts       # GET, PUT { body } (NEW)
├── components/                           # shadcn/ui primitives (NEW)
│   └── ui/
│       ├── button.tsx
│       ├── card.tsx
│       ├── dialog.tsx
│       ├── input.tsx
│       ├── tabs.tsx
│       ├── table.tsx
│       ├── select.tsx
│       ├── skeleton.tsx
│       └── toast.tsx
├── lib/
│   ├── auth/
│   │   ├── stack.ts                      # stackServerApp + helpers (NEW)
│   │   └── current-user.ts               # getCurrentUserId, requireUser (NEW)
│   └── api/
│       ├── responses.ts                  # JSON response helpers (NEW)
│       └── errors.ts                     # error → HTTP mapping (NEW)
└── tests/
    ├── api/
    │   ├── tickers-snapshot.test.ts      # route handler tests (NEW)
    │   ├── tickers-add.test.ts           # NEW
    │   ├── watchlist.test.ts             # NEW
    │   └── notes.test.ts                 # NEW
    └── integration/
        └── api-route-handlers.test.ts    # full HTTP flow against real DB (NEW)
```

**Responsibilities:**

- **`stack.ts` + `lib/auth/*`** — Stack Auth setup; one place that knows how to read the current user.
- **`middleware.ts`** — runs on every request; ensures Stack Auth session is refreshed and (for protected routes) redirects to login if absent.
- **`app/handler/[...stack]`** — Stack Auth's catch-all that hosts /handler/signin, /handler/signup, /handler/oauth-callback, /handler/account, etc.
- **`app/(app)/layout.tsx`** — server-gated shell. If no session, redirect to /handler/signin. Renders top nav + children.
- **`app/api/**`** — thin HTTP shells. Pattern: read user → withUserContext → call service → mapError to HTTP.
- **`app/(app)/**/page.tsx`** — RSC. Fetches data server-side via services, passes serializable props to client islands.
- **`app/(app)/**/_components/*`** — client components for interactivity (charts, forms, editors).
- **`components/ui/*`** — shadcn primitives, project-owned (shadcn copies them into your repo).

---

## Milestone 1: Stack Auth integration

Goal: Stack Auth wired up; signup/login work end-to-end; server code can resolve the current user.

### Task 1.1: Create `stack.ts` and `lib/auth/stack.ts`

**Files:**
- Create: `stack.ts`
- Create: `lib/auth/stack.ts`

- [ ] **Step 1: Write `stack.ts` at project root**

```ts
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
```

The `'server-only'` import causes Next.js to throw at build time if this module is ever pulled into a client bundle.

- [ ] **Step 2: Write `lib/auth/stack.ts` as the public re-export**

```ts
export { stackServerApp } from '@/stack';
```

This indirection lets future tests stub `stackServerApp` by mocking `@/lib/auth/stack` without touching the top-level config.

- [ ] **Step 3: Verify typecheck**

Run: `cd "C:/Users/elinw/Projects/equity-research-workbench" && pnpm typecheck`
Expected: exit 0.

If `@stackframe/stack` complains about a missing type definition for `StackServerApp`, double-check installed version. We installed `@stackframe/stack` in Phase 1A.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add stack.ts lib/auth/stack.ts
git commit -m "feat(auth): Stack Auth server app config"
```

---

### Task 1.2: Create the Stack Auth handler route

**Files:**
- Create: `app/handler/[...stack]/page.tsx`

- [ ] **Step 1: Write the handler page**

```tsx
import { StackHandler } from '@stackframe/stack';
import { stackServerApp } from '@/stack';

export default function Handler(props: unknown) {
  return <StackHandler fullPage app={stackServerApp} routeProps={props} />;
}
```

The `[...stack]` catch-all forwards every URL under `/handler/*` to Stack Auth's built-in UI (signin, signup, OAuth callbacks, password reset, account management).

- [ ] **Step 2: Verify build**

Run: `cd "C:/Users/elinw/Projects/equity-research-workbench" && pnpm build 2>&1 | tail -15`
Expected: "Compiled successfully", `/handler/[...stack]` listed in the route summary.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add app/handler
git commit -m "feat(auth): Stack Auth /handler catch-all route"
```

---

### Task 1.3: Add session middleware

**Files:**
- Create: `middleware.ts`

- [ ] **Step 1: Write middleware**

```ts
import { stackServerApp } from '@/stack';
import { NextResponse, type NextRequest } from 'next/server';

const PROTECTED_PREFIXES = ['/watchlist', '/stock', '/api'];
const PUBLIC_API_PREFIXES = ['/api/health', '/api/cron'];

export async function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname;

  // /handler/* is always public — Stack Auth manages its own session.
  if (pathname.startsWith('/handler')) return NextResponse.next();

  // Public APIs (health, cron) are not session-gated; cron uses its own bearer auth.
  if (PUBLIC_API_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const needsAuth = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  if (!needsAuth) return NextResponse.next();

  const user = await stackServerApp.getUser({ tokenStore: req });
  if (user) return NextResponse.next();

  // API request without a session → 401
  if (pathname.startsWith('/api')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Page request → redirect to signin with `after`
  const signIn = new URL('/handler/signin', req.nextUrl);
  signIn.searchParams.set('after_auth_return_to', pathname);
  return NextResponse.redirect(signIn);
}

export const config = {
  matcher: ['/((?!_next/|favicon|.*\\..*).*)']
};
```

The matcher excludes `_next/`, `favicon`, and any file extension (so static assets aren't middleware-processed).

- [ ] **Step 2: Verify build**

Run: `cd "C:/Users/elinw/Projects/equity-research-workbench" && pnpm build 2>&1 | tail -10`
Expected: build succeeds. Middleware should be listed.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add middleware.ts
git commit -m "feat(auth): session middleware with protected route prefixes"
```

---

### Task 1.4: `lib/auth/current-user.ts` — server-side user helpers

**Files:**
- Create: `lib/auth/current-user.ts`

These helpers are used by API route handlers and RSC pages.

- [ ] **Step 1: Write the helpers**

```ts
import 'server-only';
import { stackServerApp } from '@/stack';

/**
 * Returns the current Stack Auth user id, or null if no session.
 * Use in RSC pages or route handlers that want optional auth.
 */
export async function getCurrentUserId(): Promise<string | null> {
  const user = await stackServerApp.getUser();
  return user?.id ?? null;
}

/**
 * Returns the current user id or throws if not signed in.
 * Use in route handlers behind the middleware (which already 401s for /api),
 * as belt-and-suspenders type safety.
 */
export async function requireUserId(): Promise<string> {
  const id = await getCurrentUserId();
  if (!id) throw new UnauthorizedError('Not signed in');
  return id;
}

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd "C:/Users/elinw/Projects/equity-research-workbench" && pnpm typecheck`

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add lib/auth/current-user.ts
git commit -m "feat(auth): getCurrentUserId + requireUserId helpers"
```

---

### Task 1.5: Manual smoke test — signup and login work

This step has no code changes; it validates the wire-up.

- [ ] **Step 1: Start the dev server**

Run: `cd "C:/Users/elinw/Projects/equity-research-workbench" && pnpm dev`
Expected: starts on http://localhost:3000.

- [ ] **Step 2: Visit `/watchlist` while logged out**

Browser → http://localhost:3000/watchlist
Expected: redirect to `/handler/signin?after_auth_return_to=%2Fwatchlist`.

- [ ] **Step 3: Sign up**

On the signin page, click "Sign up" link → create an account with email/password. Stack Auth's hosted UI handles the form.
Expected: lands at `/watchlist` (which 404s for now — that's fine; auth landed you somewhere protected).

- [ ] **Step 4: Sign out**

Visit `/handler/sign-out` or click account → sign out.
Expected: returns to `/`.

- [ ] **Step 5: Verify with curl that protected API 401s without session**

```bash
curl -i http://localhost:3000/api/watchlist
```
Expected: `HTTP/1.1 401 Unauthorized` + body `{"error":"Unauthorized"}`.

- [ ] **Step 6: Stop the dev server**

Ctrl-C. No commit — this task was verification only.

---

## Milestone 2: Tailwind + shadcn/ui setup

Goal: styling pipeline in place; minimal shadcn primitives installed.

### Task 2.1: Install Tailwind + dependencies

**Files:**
- Modify: `package.json` (deps added)
- Create: `tailwind.config.ts`
- Create: `postcss.config.mjs`
- Create: `app/globals.css`

- [ ] **Step 1: Install Tailwind v3 + dependencies**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm add -D tailwindcss@^3 postcss autoprefixer tailwindcss-animate
pnpm add class-variance-authority clsx tailwind-merge lucide-react
```

(Pin Tailwind to v3 explicitly. shadcn/ui has full v4 support but the canonical setup we use here assumes v3. Upgrading is a Slice 1.5 task.)

- [ ] **Step 2: Write `tailwind.config.ts`**

```ts
import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

const config: Config = {
  darkMode: ['class'],
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1rem', screens: { '2xl': '1400px' } },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))'
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))'
        }
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)'
      }
    }
  },
  plugins: [animate]
};

export default config;
```

- [ ] **Step 3: Write `postcss.config.mjs`**

```js
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} }
};
```

- [ ] **Step 4: Write `app/globals.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 240 10% 3.9%;
    --card: 0 0% 100%;
    --card-foreground: 240 10% 3.9%;
    --primary: 240 5.9% 10%;
    --primary-foreground: 0 0% 98%;
    --secondary: 240 4.8% 95.9%;
    --secondary-foreground: 240 5.9% 10%;
    --muted: 240 4.8% 95.9%;
    --muted-foreground: 240 3.8% 46.1%;
    --accent: 240 4.8% 95.9%;
    --accent-foreground: 240 5.9% 10%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 0 0% 98%;
    --border: 240 5.9% 90%;
    --input: 240 5.9% 90%;
    --ring: 240 5.9% 10%;
    --radius: 0.5rem;
  }

  .dark {
    --background: 240 10% 3.9%;
    --foreground: 0 0% 98%;
    --card: 240 10% 3.9%;
    --card-foreground: 0 0% 98%;
    --primary: 0 0% 98%;
    --primary-foreground: 240 5.9% 10%;
    --secondary: 240 3.7% 15.9%;
    --secondary-foreground: 0 0% 98%;
    --muted: 240 3.7% 15.9%;
    --muted-foreground: 240 5% 64.9%;
    --accent: 240 3.7% 15.9%;
    --accent-foreground: 0 0% 98%;
    --destructive: 0 62.8% 30.6%;
    --destructive-foreground: 0 0% 98%;
    --border: 240 3.7% 15.9%;
    --input: 240 3.7% 15.9%;
    --ring: 240 4.9% 83.9%;
  }

  * { @apply border-border; }
  body { @apply bg-background text-foreground; }
}
```

- [ ] **Step 5: Update `app/layout.tsx` to import globals**

Replace the existing minimal `app/layout.tsx` content with:

```tsx
import type { ReactNode } from 'react';
import { StackProvider, StackTheme } from '@stackframe/stack';
import { stackServerApp } from '@/stack';
import './globals.css';

export const metadata = {
  title: 'Equity Research Workbench',
  description: 'Single-pane research dossier for any US-listed equity.'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <StackProvider app={stackServerApp}>
          <StackTheme>{children}</StackTheme>
        </StackProvider>
      </body>
    </html>
  );
}
```

Defaulting to `className="dark"` makes the app dark-by-default (Bloomberg aesthetic per the spec).

- [ ] **Step 6: Verify build**

Run: `cd "C:/Users/elinw/Projects/equity-research-workbench" && pnpm build 2>&1 | tail -15`
Expected: "Compiled successfully". Tailwind warnings about purge content paths are acceptable.

- [ ] **Step 7: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add tailwind.config.ts postcss.config.mjs app/globals.css app/layout.tsx package.json pnpm-lock.yaml
git commit -m "feat(ui): Tailwind v3 + Stack Auth provider + dark theme defaults"
```

---

### Task 2.2: Install shadcn primitives

**Files:**
- Create: `components.json`
- Create: `lib/utils.ts`
- Create: `components/ui/button.tsx`
- Create: `components/ui/card.tsx`
- Create: `components/ui/dialog.tsx`
- Create: `components/ui/input.tsx`
- Create: `components/ui/tabs.tsx`
- Create: `components/ui/table.tsx`
- Create: `components/ui/select.tsx`
- Create: `components/ui/skeleton.tsx`
- Create: `components/ui/toast.tsx`
- Create: `components/ui/toaster.tsx`

shadcn copies component source into the project — they become project-owned files we can edit freely.

- [ ] **Step 1: Initialize shadcn config**

Don't run the interactive `pnpm dlx shadcn init` — write `components.json` directly:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.ts",
    "css": "app/globals.css",
    "baseColor": "zinc",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

- [ ] **Step 2: Write `lib/utils.ts` (the `cn` helper shadcn uses)**

```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 3: Install shadcn primitives via the CLI**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm dlx shadcn@latest add button card dialog input tabs table select skeleton toast --yes
```

This populates `components/ui/*` with the canonical shadcn implementations.

If the CLI prompts about file overwrites or anything interactive, pass `--overwrite` or accept defaults. If it doesn't accept `--yes`, run individually:
```bash
pnpm dlx shadcn@latest add button
pnpm dlx shadcn@latest add card
# … etc
```

- [ ] **Step 4: Add the toaster mount**

The toast component needs a `<Toaster />` mounted in the root layout. If shadcn generated `components/ui/toaster.tsx`, import it. Otherwise add:

```tsx
// components/ui/toaster.tsx (if not auto-generated)
'use client';
import { Toast, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from '@/components/ui/toast';
import { useToast } from '@/hooks/use-toast';

export function Toaster() {
  const { toasts } = useToast();
  return (
    <ToastProvider>
      {toasts.map(({ id, title, description, action, ...props }) => (
        <Toast key={id} {...props}>
          <div className="grid gap-1">
            {title && <ToastTitle>{title}</ToastTitle>}
            {description && <ToastDescription>{description}</ToastDescription>}
          </div>
          {action}
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}
```

Update `app/layout.tsx` to render `<Toaster />` inside `<StackTheme>`:

```tsx
import { Toaster } from '@/components/ui/toaster';
// …
<StackTheme>
  {children}
  <Toaster />
</StackTheme>
```

- [ ] **Step 5: Verify build**

Run: `cd "C:/Users/elinw/Projects/equity-research-workbench" && pnpm build 2>&1 | tail -10`
Expected: clean build.

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add components.json lib/utils.ts components/ hooks/ app/layout.tsx
git commit -m "feat(ui): install shadcn primitives + Toaster mount"
```

---

## Milestone 3: API route handlers — read-only ticker data

Goal: GET endpoints that return snapshot/financials/prices for a ticker. All authenticated. Thin shells over the existing services.

### Task 3.1: `lib/api/errors.ts` + `lib/api/responses.ts`

**Files:**
- Create: `lib/api/errors.ts`
- Create: `lib/api/responses.ts`

These are shared utilities every route handler uses.

- [ ] **Step 1: Write `lib/api/errors.ts`**

```ts
import {
  NotFoundError,
  ProviderError,
  RateLimitError,
  ValidationError
} from '@/lib/providers/types';
import { UnauthorizedError } from '@/lib/auth/current-user';
import { logger } from '@/lib/logger';
import { NextResponse } from 'next/server';

export interface ApiError {
  status: number;
  body: { error: string; details?: unknown };
  headers?: Record<string, string>;
}

/** Map an internal error to a route-handler-ready `ApiError` envelope. */
export function mapError(err: unknown, context: Record<string, unknown> = {}): ApiError {
  if (err instanceof UnauthorizedError) {
    return { status: 401, body: { error: 'Unauthorized' } };
  }
  if (err instanceof NotFoundError) {
    return { status: 404, body: { error: err.message || 'Not found' } };
  }
  if (err instanceof ValidationError) {
    return { status: 400, body: { error: err.message || 'Bad request' } };
  }
  if (err instanceof RateLimitError) {
    return {
      status: 503,
      body: { error: 'Upstream rate limit; try again shortly' },
      headers: { 'Retry-After': '30' }
    };
  }
  if (err instanceof ProviderError) {
    return {
      status: 503,
      body: { error: 'Upstream provider error' },
      headers: { 'Retry-After': '30' }
    };
  }
  // Unknown — log and return generic 500.
  logger.error({ err: String(err), context }, 'api: unhandled error');
  return { status: 500, body: { error: 'Internal server error' } };
}

export function errorResponse(err: unknown, context?: Record<string, unknown>): NextResponse {
  const { status, body, headers } = mapError(err, context);
  return NextResponse.json(body, { status, headers });
}
```

- [ ] **Step 2: Write `lib/api/responses.ts`**

```ts
import { NextResponse } from 'next/server';

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export function created<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, { status: 201, ...init });
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 });
}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd "C:/Users/elinw/Projects/equity-research-workbench" && pnpm typecheck`

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add lib/api/
git commit -m "feat(api): shared error + response helpers"
```

---

### Task 3.2: `app/api/tickers/[symbol]/snapshot/route.ts`

**Files:**
- Create: `app/api/tickers/[symbol]/snapshot/route.ts`
- Create: `tests/integration/api-tickers-snapshot.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, snapshots } from '@/lib/db/schema';

config({ path: '.env.local' });

// We test the route handler by calling its exported `GET` function directly
// with a stubbed Request. No HTTP server, no middleware — just the handler.

describe('GET /api/tickers/[symbol]/snapshot', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    await dbH.db.insert(snapshots).values({
      ticker: 'AAPL',
      price: '195.40', marketCap: '3100000000000',
      week52High: '220.50', week52Low: '165.00',
      pe: '28.50', ps: '7.80', pb: '45.20', evEbitda: '22.10', peg: '2.40',
      asOf: new Date(), source: 'financial_datasets'
    });
  });

  it('returns 200 with snapshot JSON for a known ticker', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/snapshot/route');
    const req = new Request('http://localhost/api/tickers/AAPL/snapshot');
    const res = await GET(req, { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticker).toBe('AAPL');
    expect(body.price).toBeCloseTo(195.4);
  });

  it('returns 404 when ticker not in DB and provider would also miss', async () => {
    // This route doesn't make provider calls — it relies on the DB or returns 404.
    // For a ticker we haven't ingested, expect 404.
    const { GET } = await import('@/app/api/tickers/[symbol]/snapshot/route');
    const req = new Request('http://localhost/api/tickers/ZZZZZZ/snapshot');
    const res = await GET(req, { params: { symbol: 'ZZZZZZ' } });
    expect(res.status).toBe(404);
  });

  it('rejects invalid ticker format with 400', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/snapshot/route');
    const req = new Request('http://localhost/api/tickers/lower-case/snapshot');
    const res = await GET(req, { params: { symbol: 'lower-case' } });
    expect(res.status).toBe(400);
  });
});
```

Note: We're testing the route handler in isolation; auth check is bypassed because the test calls `GET` directly (the middleware doesn't run inside Vitest). The auth check inside the handler is still important — see Step 3 — and will be exercised in Phase 1C E2E tests.

- [ ] **Step 2: Run, verify fails**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration tests/integration/api-tickers-snapshot.test.ts
```

- [ ] **Step 3: Write the route handler**

```ts
// app/api/tickers/[symbol]/snapshot/route.ts
import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/providers/types';
import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { SnapshotService } from '@/lib/services/snapshot';
import { loadServerEnv } from '@/lib/env';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface RouteContext {
  params: { symbol: string };
}

let svc: SnapshotService | null = null;
function service(): SnapshotService {
  if (svc) return svc;
  const env = loadServerEnv();
  svc = new SnapshotService({
    db: getServiceDb(),
    primary: new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY }),
    fallback: new YFinanceProvider(),
    redis: getRedisCache()
  });
  return svc;
}

export async function GET(_req: Request, ctx: RouteContext) {
  try {
    const { symbol } = ctx.params;
    if (!TICKER_RE.test(symbol)) {
      throw new ValidationError(`Invalid ticker: ${symbol}`);
    }
    const snap = await service().get(symbol);
    if (!snap) throw new NotFoundError(`No snapshot for ${symbol}`);
    return ok(snap);
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/snapshot' });
  }
}
```

The service singleton uses module-scope memoization — same pattern as Phase 1A scripts. Note we use `getServiceDb()` (BYPASSRLS) since reference data is readable by anyone authenticated.

- [ ] **Step 4: Run, verify passes**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration tests/integration/api-tickers-snapshot.test.ts
```
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add app/api/tickers/[symbol]/snapshot/ tests/integration/api-tickers-snapshot.test.ts
git commit -m "feat(api): GET /api/tickers/[symbol]/snapshot"
```

---

### Task 3.3: `app/api/tickers/[symbol]/financials/route.ts`

**Files:**
- Create: `app/api/tickers/[symbol]/financials/route.ts`
- Create: `tests/integration/api-tickers-financials.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, fundamentals } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('GET /api/tickers/[symbol]/financials', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    await dbH.db.insert(fundamentals).values([
      { ticker: 'AAPL', periodEnd: '2024-09-30', periodType: 'annual', statementType: 'income', lineItem: 'revenue', value: '383285000000', currency: 'USD', source: 'financial_datasets' },
      { ticker: 'AAPL', periodEnd: '2024-09-30', periodType: 'annual', statementType: 'income', lineItem: 'net_income', value: '99803000000', currency: 'USD', source: 'financial_datasets' }
    ]);
  });

  it('returns 200 with income annual data', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/financials/route');
    const url = new URL('http://localhost/api/tickers/AAPL/financials?type=income&period=annual');
    const req = new Request(url);
    const res = await GET(req, { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.statementType).toBe('income');
    expect(body.periodType).toBe('annual');
  });

  it('defaults type=income and period=annual when params missing', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/financials/route');
    const req = new Request('http://localhost/api/tickers/AAPL/financials');
    const res = await GET(req, { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.statementType).toBe('income');
  });

  it('rejects invalid type with 400', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/financials/route');
    const url = new URL('http://localhost/api/tickers/AAPL/financials?type=bogus');
    const req = new Request(url);
    const res = await GET(req, { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run, verify fails**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration tests/integration/api-tickers-financials.test.ts
```

- [ ] **Step 3: Write the handler**

```ts
// app/api/tickers/[symbol]/financials/route.ts
import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { FinancialsService } from '@/lib/services/financials';
import { loadServerEnv } from '@/lib/env';
import type { PeriodType, StatementType } from '@/lib/providers/types';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const STATEMENT_TYPES: readonly StatementType[] = ['income', 'balance', 'cash_flow'];
const PERIOD_TYPES: readonly PeriodType[] = ['annual', 'quarterly'];

interface RouteContext {
  params: { symbol: string };
}

let svc: FinancialsService | null = null;
function service(): FinancialsService {
  if (svc) return svc;
  const env = loadServerEnv();
  svc = new FinancialsService({
    db: getServiceDb(),
    primary: new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY }),
    fallback: new YFinanceProvider(),
    redis: getRedisCache()
  });
  return svc;
}

export async function GET(req: Request, ctx: RouteContext) {
  try {
    const { symbol } = ctx.params;
    if (!TICKER_RE.test(symbol)) {
      throw new ValidationError(`Invalid ticker: ${symbol}`);
    }
    const url = new URL(req.url);
    const type = (url.searchParams.get('type') ?? 'income') as StatementType;
    const period = (url.searchParams.get('period') ?? 'annual') as PeriodType;
    if (!STATEMENT_TYPES.includes(type)) {
      throw new ValidationError(`Invalid type: ${type}`);
    }
    if (!PERIOD_TYPES.includes(period)) {
      throw new ValidationError(`Invalid period: ${period}`);
    }
    const bundle = await service().get(symbol, type, period);
    return ok(bundle);
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/financials' });
  }
}
```

- [ ] **Step 4: Run, verify passes**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration tests/integration/api-tickers-financials.test.ts
```

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add app/api/tickers/[symbol]/financials/ tests/integration/api-tickers-financials.test.ts
git commit -m "feat(api): GET /api/tickers/[symbol]/financials"
```

---

### Task 3.4: `app/api/tickers/[symbol]/prices/route.ts`

**Files:**
- Create: `app/api/tickers/[symbol]/prices/route.ts`
- Create: `tests/integration/api-tickers-prices.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, prices } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('GET /api/tickers/[symbol]/prices', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    await dbH.db.insert(prices).values([
      { ticker: 'AAPL', date: '2025-05-23', close: '189.40', volume: BigInt(50000000), source: 'financial_datasets' }
    ]);
  });

  it('returns 200 with 1Y prices by default', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/prices/route');
    const req = new Request('http://localhost/api/tickers/AAPL/prices');
    const res = await GET(req, { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('accepts range=5Y', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/prices/route');
    const url = new URL('http://localhost/api/tickers/AAPL/prices?range=5Y');
    const req = new Request(url);
    const res = await GET(req, { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(200);
  });

  it('rejects invalid range with 400', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/prices/route');
    const url = new URL('http://localhost/api/tickers/AAPL/prices?range=bogus');
    const req = new Request(url);
    const res = await GET(req, { params: { symbol: 'AAPL' } });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run, verify fails**

- [ ] **Step 3: Write the handler**

```ts
// app/api/tickers/[symbol]/prices/route.ts
import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { PricesService } from '@/lib/services/prices';
import { loadServerEnv } from '@/lib/env';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const RANGES = ['1Y', '5Y'] as const;
type Range = (typeof RANGES)[number];

interface RouteContext {
  params: { symbol: string };
}

let svc: PricesService | null = null;
function service(): PricesService {
  if (svc) return svc;
  const env = loadServerEnv();
  svc = new PricesService({
    db: getServiceDb(),
    primary: new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY }),
    fallback: new YFinanceProvider(),
    redis: getRedisCache()
  });
  return svc;
}

export async function GET(req: Request, ctx: RouteContext) {
  try {
    const { symbol } = ctx.params;
    if (!TICKER_RE.test(symbol)) {
      throw new ValidationError(`Invalid ticker: ${symbol}`);
    }
    const url = new URL(req.url);
    const range = (url.searchParams.get('range') ?? '1Y') as Range;
    if (!RANGES.includes(range)) {
      throw new ValidationError(`Invalid range: ${range}`);
    }
    const px = await service().get(symbol, range);
    return ok(px);
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/prices' });
  }
}
```

- [ ] **Step 4: Run, verify passes**

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add app/api/tickers/[symbol]/prices/ tests/integration/api-tickers-prices.test.ts
git commit -m "feat(api): GET /api/tickers/[symbol]/prices"
```

---

## Milestone 4: API route — add ticker (on-demand ingest)

### Task 4.1: `app/api/tickers/add/route.ts`

**Files:**
- Create: `app/api/tickers/add/route.ts`
- Create: `tests/integration/api-tickers-add.test.ts`

This route is unique in two ways: it's a POST (writes data), and it makes real provider calls during request handling (on-demand ingest). Cap at 10 req/min per user via a simple Redis counter.

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { makeTestServiceDb, newUserId, resetDb } from '../helpers/test-db';
import { companies, watchlist } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('POST /api/tickers/add', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
  });

  it('400s when symbol missing from body', async () => {
    // Stub the auth helper for tests.
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => newUserId(),
      getCurrentUserId: async () => newUserId(),
      UnauthorizedError: class extends Error {}
    }));
    const { POST } = await import('@/app/api/tickers/add/route');
    const req = new Request('http://localhost/api/tickers/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('400s on invalid symbol format', async () => {
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => newUserId(),
      UnauthorizedError: class extends Error {}
    }));
    const { POST } = await import('@/app/api/tickers/add/route');
    const req = new Request('http://localhost/api/tickers/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: 'lowercase' })
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  // NOTE: A full happy-path test against the live FD API is intentionally
  // omitted to keep the integration test deterministic. Smoke-test via
  // `pnpm try TSLA` post-implementation instead.
});
```

`vi.doMock` lets us stub `@/lib/auth/current-user` per-test without touching the route module.

- [ ] **Step 2: Write the handler**

```ts
// app/api/tickers/add/route.ts
import { errorResponse } from '@/lib/api/errors';
import { created, ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb, withUserContext } from '@/lib/db/client';
import { companies } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { SnapshotService } from '@/lib/services/snapshot';
import { FinancialsService } from '@/lib/services/financials';
import { PricesService } from '@/lib/services/prices';
import { WatchlistService } from '@/lib/services/watchlist';
import { loadServerEnv } from '@/lib/env';
import { logger } from '@/lib/logger';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const RATE_LIMIT_PER_MIN = 10;

interface ServiceBundle {
  snapshot: SnapshotService;
  financials: FinancialsService;
  prices: PricesService;
  watchlist: WatchlistService;
}

let services: ServiceBundle | null = null;
function getServices(): ServiceBundle {
  if (services) return services;
  const env = loadServerEnv();
  const db = getServiceDb();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const yf = new YFinanceProvider();
  const redis = getRedisCache();
  services = {
    snapshot: new SnapshotService({ db, primary: fd, fallback: yf, redis }),
    financials: new FinancialsService({ db, primary: fd, fallback: yf, redis }),
    prices: new PricesService({ db, primary: fd, fallback: yf, redis }),
    watchlist: new WatchlistService(db)
  };
  return services;
}

async function rateLimit(userId: string): Promise<boolean> {
  const redis = getRedisCache();
  const key = `ratelimit:add-ticker:${userId}`;
  const cur = (await redis.get<number>(key)) ?? 0;
  if (cur >= RATE_LIMIT_PER_MIN) return false;
  await redis.set(key, cur + 1, 60);
  return true;
}

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    if (!(await rateLimit(userId))) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'Retry-After': '60' }
      });
    }

    const body = (await req.json().catch(() => ({}))) as { symbol?: unknown };
    if (typeof body.symbol !== 'string') {
      throw new ValidationError('symbol is required');
    }
    const symbol = body.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) {
      throw new ValidationError(`Invalid symbol: ${body.symbol}`);
    }

    const svcs = getServices();
    const db = getServiceDb();

    // Short-circuit if already known.
    const existing = await db.select().from(companies).where(eq(companies.ticker, symbol)).limit(1);
    if (existing.length > 0) {
      await svcs.watchlist.add(userId, symbol);
      return ok({ ticker: symbol, redirectTo: `/stock/${symbol}` });
    }

    // On-demand ingest: snapshot + financials (income/balance/cash_flow) + prices, in parallel.
    logger.info({ userId, symbol }, 'add-ticker: ingest start');
    await db.insert(companies).values({ ticker: symbol, name: symbol }).onConflictDoNothing();

    const results = await Promise.allSettled([
      svcs.snapshot.refresh(symbol),
      svcs.financials.refresh(symbol, 'income', 'annual'),
      svcs.financials.refresh(symbol, 'balance', 'annual'),
      svcs.financials.refresh(symbol, 'cash_flow', 'annual'),
      svcs.prices.refresh(symbol, '1Y')
    ]);

    // If snapshot AND prices both failed, the ticker is probably bogus.
    const snapshotFailed = results[0]!.status === 'rejected';
    const pricesFailed = results[4]!.status === 'rejected';
    if (snapshotFailed && pricesFailed) {
      // Roll back the companies row to avoid littering on failed ingests.
      await db.delete(companies).where(eq(companies.ticker, symbol));
      throw (results[0] as PromiseRejectedResult).reason;
    }

    await svcs.watchlist.add(userId, symbol);
    logger.info({ userId, symbol, ingested: results.map((r) => r.status) }, 'add-ticker: done');
    return created({ ticker: symbol, redirectTo: `/stock/${symbol}` });
  } catch (err) {
    return errorResponse(err, { route: 'tickers/add' });
  }
}
```

- [ ] **Step 3: Run, verify tests pass**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration tests/integration/api-tickers-add.test.ts
```
Expected: 2 passing.

- [ ] **Step 4: Smoke-test against live providers**

Start dev server (`pnpm dev`), sign in via browser, then in PowerShell:

```powershell
# Grab the session cookie from your browser's devtools and paste below.
curl -X POST http://localhost:3000/api/tickers/add `
  -H "Content-Type: application/json" `
  -H "Cookie: stack-auth-session=..." `
  -d '{"symbol":"TSLA"}'
```

Expected: 201 with `{"ticker":"TSLA","redirectTo":"/stock/TSLA"}` after a 3–5s pause.

If you don't want to mess with cookies right now, defer this step — Phase 1B M5 (watchlist UI) will exercise the same path in-browser.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add app/api/tickers/add/ tests/integration/api-tickers-add.test.ts
git commit -m "feat(api): POST /api/tickers/add with on-demand ingest + rate limit"
```

---

## Milestone 5: API routes — watchlist + notes

### Task 5.1: `app/api/watchlist/route.ts` — GET + POST + DELETE

**Files:**
- Create: `app/api/watchlist/route.ts`
- Create: `tests/integration/api-watchlist.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { eq, and } from 'drizzle-orm';
import { makeTestServiceDb, newUserId, resetDb } from '../helpers/test-db';
import { companies, watchlist } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('/api/watchlist', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  let testUserId: string;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });

  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values([
      { ticker: 'AAPL', name: 'Apple' },
      { ticker: 'MSFT', name: 'Microsoft' }
    ]);
    testUserId = newUserId();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => testUserId,
      UnauthorizedError: class extends Error {}
    }));
  });

  it('GET returns the user watchlist', async () => {
    await dbH.db.insert(watchlist).values({ userId: testUserId, ticker: 'AAPL' });
    const { GET } = await import('@/app/api/watchlist/route');
    const res = await GET(new Request('http://localhost/api/watchlist'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([{ ticker: 'AAPL' }]);
  });

  it('POST adds a ticker', async () => {
    const { POST } = await import('@/app/api/watchlist/route');
    const res = await POST(new Request('http://localhost/api/watchlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticker: 'AAPL' })
    }));
    expect(res.status).toBe(201);
    const rows = await dbH.db.select().from(watchlist).where(and(eq(watchlist.userId, testUserId), eq(watchlist.ticker, 'AAPL')));
    expect(rows).toHaveLength(1);
  });

  it('POST is idempotent (no error on duplicate)', async () => {
    const { POST } = await import('@/app/api/watchlist/route');
    const make = () => new Request('http://localhost/api/watchlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticker: 'AAPL' })
    });
    await POST(make());
    const res = await POST(make());
    expect(res.status).toBe(201);
  });
});
```

- [ ] **Step 2: Write the handler**

```ts
// app/api/watchlist/route.ts
import { errorResponse } from '@/lib/api/errors';
import { created, ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { WatchlistService } from '@/lib/services/watchlist';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

let svc: WatchlistService | null = null;
function service() {
  if (!svc) svc = new WatchlistService(getServiceDb());
  return svc;
}

export async function GET(_req: Request) {
  try {
    const userId = await requireUserId();
    const rows = await service().list(userId);
    return ok(rows);
  } catch (err) {
    return errorResponse(err, { route: 'watchlist GET' });
  }
}

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const body = (await req.json().catch(() => ({}))) as { ticker?: unknown };
    if (typeof body.ticker !== 'string') {
      throw new ValidationError('ticker is required');
    }
    const ticker = body.ticker.toUpperCase();
    if (!TICKER_RE.test(ticker)) {
      throw new ValidationError(`Invalid ticker: ${body.ticker}`);
    }
    await service().add(userId, ticker);
    return created({ ticker });
  } catch (err) {
    return errorResponse(err, { route: 'watchlist POST' });
  }
}
```

- [ ] **Step 3: Run, verify passes**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration tests/integration/api-watchlist.test.ts
```
Expected: 3 passing.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add app/api/watchlist/route.ts tests/integration/api-watchlist.test.ts
git commit -m "feat(api): GET + POST /api/watchlist"
```

---

### Task 5.2: `app/api/watchlist/[ticker]/route.ts` — DELETE

**Files:**
- Create: `app/api/watchlist/[ticker]/route.ts`
- Append to: `tests/integration/api-watchlist.test.ts`

- [ ] **Step 1: Append failing tests to existing watchlist test file**

```ts
  it('DELETE removes a ticker', async () => {
    await dbH.db.insert(watchlist).values({ userId: testUserId, ticker: 'AAPL' });
    const { DELETE } = await import('@/app/api/watchlist/[ticker]/route');
    const res = await DELETE(new Request('http://localhost/api/watchlist/AAPL', { method: 'DELETE' }), {
      params: { ticker: 'AAPL' }
    });
    expect(res.status).toBe(204);
    const rows = await dbH.db.select().from(watchlist).where(and(eq(watchlist.userId, testUserId), eq(watchlist.ticker, 'AAPL')));
    expect(rows).toHaveLength(0);
  });

  it('DELETE is idempotent (204 even if not present)', async () => {
    const { DELETE } = await import('@/app/api/watchlist/[ticker]/route');
    const res = await DELETE(new Request('http://localhost/api/watchlist/AAPL', { method: 'DELETE' }), {
      params: { ticker: 'AAPL' }
    });
    expect(res.status).toBe(204);
  });
```

- [ ] **Step 2: Write the handler**

```ts
// app/api/watchlist/[ticker]/route.ts
import { errorResponse } from '@/lib/api/errors';
import { noContent } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { WatchlistService } from '@/lib/services/watchlist';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface RouteContext {
  params: { ticker: string };
}

let svc: WatchlistService | null = null;
function service() {
  if (!svc) svc = new WatchlistService(getServiceDb());
  return svc;
}

export async function DELETE(_req: Request, ctx: RouteContext) {
  try {
    const userId = await requireUserId();
    const { ticker } = ctx.params;
    if (!TICKER_RE.test(ticker)) {
      throw new ValidationError(`Invalid ticker: ${ticker}`);
    }
    await service().remove(userId, ticker);
    return noContent();
  } catch (err) {
    return errorResponse(err, { route: 'watchlist DELETE' });
  }
}
```

- [ ] **Step 3: Run, verify passes**

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add app/api/watchlist/[ticker]/route.ts tests/integration/api-watchlist.test.ts
git commit -m "feat(api): DELETE /api/watchlist/[ticker]"
```

---

### Task 5.3: `app/api/notes/[ticker]/route.ts` — GET + PUT

**Files:**
- Create: `app/api/notes/[ticker]/route.ts`
- Create: `tests/integration/api-notes.test.ts`
- Create: `lib/services/notes.ts`

We didn't build a `NotesService` in Phase 1A (notes weren't on M6's task list). Build it now alongside the route. The schema row `notes` is already there.

- [ ] **Step 1: Write `lib/services/notes.ts`**

```ts
import { and, eq } from 'drizzle-orm';
import { notes } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';

const MAX_NOTE_BYTES = 50_000;

export class NotesService {
  constructor(private readonly db: ServiceDb) {}

  async get(userId: string, ticker: string): Promise<string> {
    const rows = await this.db
      .select({ body: notes.body })
      .from(notes)
      .where(and(eq(notes.userId, userId), eq(notes.ticker, ticker.toUpperCase())))
      .limit(1);
    return rows[0]?.body ?? '';
  }

  async upsert(userId: string, ticker: string, body: string): Promise<void> {
    if (body.length > MAX_NOTE_BYTES) {
      throw new Error(`Note body exceeds ${MAX_NOTE_BYTES} bytes`);
    }
    await this.db
      .insert(notes)
      .values({ userId, ticker: ticker.toUpperCase(), body, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [notes.userId, notes.ticker],
        set: { body, updatedAt: new Date() }
      });
  }
}
```

- [ ] **Step 2: Write the failing integration test**

```ts
// tests/integration/api-notes.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, newUserId, resetDb } from '../helpers/test-db';
import { companies } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('/api/notes/[ticker]', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  let testUserId: string;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });

  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    testUserId = newUserId();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => testUserId,
      UnauthorizedError: class extends Error {}
    }));
  });

  it('GET returns empty string when no note exists', async () => {
    const { GET } = await import('@/app/api/notes/[ticker]/route');
    const res = await GET(new Request('http://localhost/api/notes/AAPL'), {
      params: { ticker: 'AAPL' }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.body).toBe('');
  });

  it('PUT then GET round-trips the note body', async () => {
    const { PUT, GET } = await import('@/app/api/notes/[ticker]/route');
    const putRes = await PUT(new Request('http://localhost/api/notes/AAPL', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '# AAPL thesis\n\nGreat company.' })
    }), { params: { ticker: 'AAPL' } });
    expect(putRes.status).toBe(204);

    const getRes = await GET(new Request('http://localhost/api/notes/AAPL'), {
      params: { ticker: 'AAPL' }
    });
    const body = await getRes.json();
    expect(body.body).toBe('# AAPL thesis\n\nGreat company.');
  });

  it('PUT 400s on oversized body', async () => {
    const { PUT } = await import('@/app/api/notes/[ticker]/route');
    const huge = 'a'.repeat(60_000);
    const res = await PUT(new Request('http://localhost/api/notes/AAPL', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: huge })
    }), { params: { ticker: 'AAPL' } });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Write the handler**

```ts
// app/api/notes/[ticker]/route.ts
import { errorResponse } from '@/lib/api/errors';
import { noContent, ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { NotesService } from '@/lib/services/notes';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const MAX_NOTE_BYTES = 50_000;

interface RouteContext {
  params: { ticker: string };
}

let svc: NotesService | null = null;
function service() {
  if (!svc) svc = new NotesService(getServiceDb());
  return svc;
}

export async function GET(_req: Request, ctx: RouteContext) {
  try {
    const userId = await requireUserId();
    const { ticker } = ctx.params;
    if (!TICKER_RE.test(ticker)) {
      throw new ValidationError(`Invalid ticker: ${ticker}`);
    }
    const body = await service().get(userId, ticker);
    return ok({ ticker, body });
  } catch (err) {
    return errorResponse(err, { route: 'notes GET' });
  }
}

export async function PUT(req: Request, ctx: RouteContext) {
  try {
    const userId = await requireUserId();
    const { ticker } = ctx.params;
    if (!TICKER_RE.test(ticker)) {
      throw new ValidationError(`Invalid ticker: ${ticker}`);
    }
    const parsed = (await req.json().catch(() => ({}))) as { body?: unknown };
    if (typeof parsed.body !== 'string') {
      throw new ValidationError('body is required');
    }
    if (parsed.body.length > MAX_NOTE_BYTES) {
      throw new ValidationError(`Note body exceeds ${MAX_NOTE_BYTES} bytes`);
    }
    await service().upsert(userId, ticker, parsed.body);
    return noContent();
  } catch (err) {
    return errorResponse(err, { route: 'notes PUT' });
  }
}
```

- [ ] **Step 4: Run, verify passes**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test:integration tests/integration/api-notes.test.ts
```
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add app/api/notes/ lib/services/notes.ts tests/integration/api-notes.test.ts
git commit -m "feat(api): GET + PUT /api/notes/[ticker] with NotesService"
```

---

## Milestone 6: Authenticated app shell

Goal: the `(app)/` route group with a top nav and session gating.

### Task 6.1: Authenticated layout + nav

**Files:**
- Create: `app/(app)/layout.tsx`
- Create: `app/(app)/_components/nav.tsx`
- Modify: `app/page.tsx` (logged-out landing)

- [ ] **Step 1: Write the gated layout**

```tsx
// app/(app)/layout.tsx
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { stackServerApp } from '@/stack';
import { Nav } from './_components/nav';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await stackServerApp.getUser();
  if (!user) redirect('/handler/signin');

  return (
    <div className="min-h-screen flex flex-col">
      <Nav userEmail={user.primaryEmail ?? user.id} />
      <main className="container mx-auto py-6 px-4 flex-1">{children}</main>
      <footer className="container mx-auto py-4 px-4 text-xs text-muted-foreground border-t border-border">
        Not investment advice. Data from Financial Datasets and Yahoo Finance.
      </footer>
    </div>
  );
}
```

- [ ] **Step 2: Write the nav (client island)**

```tsx
// app/(app)/_components/nav.tsx
'use client';

import Link from 'next/link';
import { UserButton } from '@stackframe/stack';
import { Button } from '@/components/ui/button';
import { PlusIcon } from 'lucide-react';

export function Nav({ userEmail }: { userEmail: string }) {
  return (
    <header className="border-b border-border">
      <div className="container mx-auto px-4 h-14 flex items-center justify-between">
        <nav className="flex items-center gap-6">
          <Link href="/watchlist" className="font-semibold tracking-tight">
            ERW
          </Link>
          <Link href="/watchlist" className="text-sm text-muted-foreground hover:text-foreground">
            Watchlist
          </Link>
        </nav>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" asChild>
            <Link href="/watchlist?add=1">
              <PlusIcon className="w-4 h-4 mr-1" /> Add ticker
            </Link>
          </Button>
          <UserButton />
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Replace `app/page.tsx` with a logged-out landing**

```tsx
// app/page.tsx
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { stackServerApp } from '@/stack';

export default async function HomePage() {
  const user = await stackServerApp.getUser();
  if (user) redirect('/watchlist');

  return (
    <main className="container mx-auto py-24 px-4 max-w-2xl">
      <h1 className="text-4xl font-bold tracking-tight">Equity Research Workbench</h1>
      <p className="mt-4 text-lg text-muted-foreground">
        Single-pane dossier for any US-listed equity. Snapshot, financials, watchlist, notes.
      </p>
      <div className="mt-8 flex gap-3">
        <Button asChild>
          <Link href="/handler/signup">Get started</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/handler/signin">Sign in</Link>
        </Button>
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Verify build**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm build 2>&1 | tail -15
```
Expected: clean build, both `/` and `/(app)/watchlist` listed.

- [ ] **Step 5: Smoke test**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench" && pnpm dev
```
- Visit `/` while logged out → see the landing
- Click "Sign in" → handler flow → after signin lands at `/watchlist` (404 still, that's M7)

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add app/page.tsx app/\(app\)/layout.tsx app/\(app\)/_components/nav.tsx
git commit -m "feat(ui): authenticated layout with nav + logged-out landing"
```

---

## Milestone 7: Watchlist page

Goal: `/watchlist` lists the user's tickers as cards with snapshot data inline; clicks navigate to the ticker dashboard.

### Task 7.1: Watchlist RSC page

**Files:**
- Create: `app/(app)/watchlist/page.tsx`
- Create: `app/(app)/watchlist/_components/watchlist-card.tsx`
- Create: `app/(app)/watchlist/_components/empty-state.tsx`

- [ ] **Step 1: Write the RSC page**

```tsx
// app/(app)/watchlist/page.tsx
import { Suspense } from 'react';
import Link from 'next/link';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { WatchlistService } from '@/lib/services/watchlist';
import { SnapshotService } from '@/lib/services/snapshot';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';
import { Skeleton } from '@/components/ui/skeleton';
import { WatchlistCard } from './_components/watchlist-card';
import { EmptyState } from './_components/empty-state';

async function getWatchlistWithSnapshots(userId: string) {
  const db = getServiceDb();
  const env = loadServerEnv();
  const watchlistSvc = new WatchlistService(db);
  const snapshotSvc = new SnapshotService({
    db,
    primary: new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY }),
    fallback: new YFinanceProvider(),
    redis: getRedisCache()
  });

  const entries = await watchlistSvc.list(userId);
  const enriched = await Promise.all(
    entries.map(async (e) => ({
      ticker: e.ticker,
      snapshot: await snapshotSvc.get(e.ticker).catch(() => null)
    }))
  );
  return enriched;
}

export default async function WatchlistPage() {
  const userId = await requireUserId();
  const items = await getWatchlistWithSnapshots(userId);

  if (items.length === 0) {
    return <EmptyState />;
  }

  return (
    <section>
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Watchlist</h1>
        <p className="text-sm text-muted-foreground">{items.length} ticker{items.length === 1 ? '' : 's'}</p>
      </header>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {items.map((item) => (
          <Link key={item.ticker} href={`/stock/${item.ticker}`}>
            <WatchlistCard ticker={item.ticker} snapshot={item.snapshot} />
          </Link>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Write the card**

```tsx
// app/(app)/watchlist/_components/watchlist-card.tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { SnapshotData } from '@/lib/providers/types';

function fmtCurrency(v: number | null) {
  if (v == null) return '—';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtMultiple(v: number | null) {
  if (v == null) return '—';
  return v.toFixed(1) + '×';
}

function fmtCompactCurrency(v: number | null) {
  if (v == null) return '—';
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  return `$${v.toFixed(0)}`;
}

export function WatchlistCard({
  ticker,
  snapshot
}: {
  ticker: string;
  snapshot: SnapshotData | null;
}) {
  return (
    <Card className="hover:bg-accent/40 transition-colors">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg font-semibold">{ticker}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">{fmtCurrency(snapshot?.price ?? null)}</div>
        <dl className="mt-4 grid grid-cols-2 gap-y-1 text-sm text-muted-foreground">
          <dt>Mkt cap</dt>
          <dd className="text-right tabular-nums">{fmtCompactCurrency(snapshot?.marketCap ?? null)}</dd>
          <dt>P/E</dt>
          <dd className="text-right tabular-nums">{fmtMultiple(snapshot?.pe ?? null)}</dd>
          <dt>P/S</dt>
          <dd className="text-right tabular-nums">{fmtMultiple(snapshot?.ps ?? null)}</dd>
        </dl>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Write the empty state**

```tsx
// app/(app)/watchlist/_components/empty-state.tsx
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PlusIcon } from 'lucide-react';

export function EmptyState() {
  return (
    <div className="py-24 text-center">
      <h2 className="text-xl font-semibold">Your watchlist is empty</h2>
      <p className="mt-2 text-muted-foreground">Add a ticker to start tracking.</p>
      <Button asChild className="mt-6">
        <Link href="/watchlist?add=1">
          <PlusIcon className="w-4 h-4 mr-1" /> Add ticker
        </Link>
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Verify build**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm build 2>&1 | tail -10
```

- [ ] **Step 5: Smoke test in browser**

`pnpm dev` → sign in → `/watchlist` should show empty state. Then add a ticker via API curl or the M8 add-ticker UI and reload.

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add app/\(app\)/watchlist/
git commit -m "feat(ui): /watchlist page with cards + empty state"
```

---

## Milestone 8: Ticker dashboard

Goal: `/stock/[ticker]` shows snapshot card, sparkline, key valuation multiples, earnings history.

### Task 8.1: Ticker dashboard RSC page + skeleton

**Files:**
- Create: `app/(app)/stock/[ticker]/page.tsx`
- Create: `app/(app)/stock/[ticker]/loading.tsx`
- Create: `app/(app)/stock/[ticker]/not-found.tsx`

- [ ] **Step 1: Write the page**

```tsx
// app/(app)/stock/[ticker]/page.tsx
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { companies } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { SnapshotService } from '@/lib/services/snapshot';
import { PricesService } from '@/lib/services/prices';
import { loadServerEnv } from '@/lib/env';
import { SnapshotCard } from './_components/snapshot-card';
import { Sparkline } from './_components/sparkline';
import { EarningsCard } from './_components/earnings-card';
import { NotesEditor } from './_components/notes-editor';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface PageProps {
  params: { ticker: string };
}

export default async function StockPage({ params }: PageProps) {
  await requireUserId();
  const { ticker: raw } = params;
  const ticker = raw.toUpperCase();
  if (!TICKER_RE.test(ticker)) notFound();

  const db = getServiceDb();
  const existing = await db.select().from(companies).where(eq(companies.ticker, ticker)).limit(1);
  if (existing.length === 0) notFound();

  const env = loadServerEnv();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const yf = new YFinanceProvider();
  const redis = getRedisCache();
  const snapshotSvc = new SnapshotService({ db, primary: fd, fallback: yf, redis });
  const pricesSvc = new PricesService({ db, primary: fd, fallback: yf, redis });

  const [snapshot, prices1Y] = await Promise.all([
    snapshotSvc.get(ticker).catch(() => null),
    pricesSvc.get(ticker, '1Y').catch(() => [])
  ]);

  return (
    <article className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{ticker}</h1>
          <p className="text-sm text-muted-foreground">{existing[0]!.name}</p>
        </div>
        <Tabs value="overview" className="hidden sm:block">
          <TabsList>
            <TabsTrigger value="overview" asChild>
              <Link href={`/stock/${ticker}`}>Overview</Link>
            </TabsTrigger>
            <TabsTrigger value="financials" asChild>
              <Link href={`/stock/${ticker}/financials`}>Financials</Link>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Snapshot</CardTitle>
          </CardHeader>
          <CardContent>
            <SnapshotCard snapshot={snapshot} />
            <Sparkline data={prices1Y} />
          </CardContent>
        </Card>

        <EarningsCard ticker={ticker} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <NotesEditor ticker={ticker} />
        </CardContent>
      </Card>
    </article>
  );
}
```

- [ ] **Step 2: Write loading + not-found**

```tsx
// app/(app)/stock/[ticker]/loading.tsx
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 w-32" />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Skeleton className="h-64 lg:col-span-2" />
        <Skeleton className="h-64" />
      </div>
      <Skeleton className="h-40" />
    </div>
  );
}
```

```tsx
// app/(app)/stock/[ticker]/not-found.tsx
import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="py-24 text-center">
      <h2 className="text-xl font-semibold">Ticker not found</h2>
      <p className="mt-2 text-muted-foreground">It may be invalid or not yet ingested.</p>
      <Button asChild className="mt-6">
        <Link href="/watchlist?add=1">Add it now</Link>
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Verify build (will fail until 8.2 ships the components)**

This is intentional — the page imports components that don't exist yet. The next task adds them. If you're worried about a broken-build commit, skip the commit on this task and bundle with Task 8.2.

Actually let's do that: don't commit yet. Move directly to Task 8.2.

---

### Task 8.2: Snapshot card, sparkline, earnings card, notes editor (client islands)

**Files:**
- Create: `app/(app)/stock/[ticker]/_components/snapshot-card.tsx`
- Create: `app/(app)/stock/[ticker]/_components/sparkline.tsx`
- Create: `app/(app)/stock/[ticker]/_components/earnings-card.tsx`
- Create: `app/(app)/stock/[ticker]/_components/notes-editor.tsx`
- Modify: `package.json` (add `recharts` + a markdown editor)

- [ ] **Step 1: Install charting + editor deps**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm add recharts react-markdown remark-gfm
```

We use `react-markdown` as a renderer; the notes editor itself is a plain `<textarea>` with a preview tab — simpler than tiptap and fine for Slice 1.

- [ ] **Step 2: Write `snapshot-card.tsx`**

```tsx
// app/(app)/stock/[ticker]/_components/snapshot-card.tsx
import type { SnapshotData } from '@/lib/providers/types';

function fmtCurrency(v: number | null, fractionDigits = 2) {
  if (v == null) return '—';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}`;
}

function fmtMultiple(v: number | null) {
  if (v == null) return '—';
  return v.toFixed(2) + '×';
}

function fmtCompactCurrency(v: number | null) {
  if (v == null) return '—';
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  return `$${v.toFixed(0)}`;
}

export function SnapshotCard({ snapshot }: { snapshot: SnapshotData | null }) {
  if (!snapshot) {
    return <p className="text-sm text-muted-foreground">No snapshot data.</p>;
  }
  const { price, marketCap, week52High, week52Low, pe, ps, pb, evEbitda, peg, asOf } = snapshot;
  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-4">
        <span className="text-4xl font-bold tabular-nums">{fmtCurrency(price)}</span>
        {(week52Low != null && week52High != null) && (
          <span className="text-sm text-muted-foreground">
            52-wk: {fmtCurrency(week52Low, 2)} – {fmtCurrency(week52High, 2)}
          </span>
        )}
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
        <Stat label="Mkt cap" value={fmtCompactCurrency(marketCap)} />
        <Stat label="P/E" value={fmtMultiple(pe)} />
        <Stat label="P/S" value={fmtMultiple(ps)} />
        <Stat label="P/B" value={fmtMultiple(pb)} />
        <Stat label="EV/EBITDA" value={fmtMultiple(evEbitda)} />
        <Stat label="PEG" value={fmtMultiple(peg)} />
      </dl>
      <p className="text-xs text-muted-foreground">
        As of {new Date(asOf).toLocaleString()}
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
```

- [ ] **Step 3: Write `sparkline.tsx`**

```tsx
// app/(app)/stock/[ticker]/_components/sparkline.tsx
'use client';

import { ResponsiveContainer, LineChart, Line, YAxis, Tooltip } from 'recharts';
import type { PricePoint } from '@/lib/providers/types';

export function Sparkline({ data }: { data: PricePoint[] }) {
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground mt-6">No price history.</p>;
  }
  const min = Math.min(...data.map((d) => d.close));
  const max = Math.max(...data.map((d) => d.close));
  return (
    <div className="mt-6 h-32">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <YAxis domain={[min * 0.95, max * 1.05]} hide />
          <Tooltip
            contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontSize: 12 }}
            labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
            formatter={(v: number) => `$${v.toFixed(2)}`}
          />
          <Line
            type="monotone"
            dataKey="close"
            stroke="hsl(var(--primary))"
            strokeWidth={1.5}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 4: Write `earnings-card.tsx`**

For Slice 1 we don't fetch earnings server-side in the dashboard page (FD's `earnings` endpoint is rate-limited and the data isn't critical for the snapshot view). We render a card with a "coming soon" stub and wire it up in Phase 1B Task 8.3 below — or defer entirely to Slice 1.5.

```tsx
// app/(app)/stock/[ticker]/_components/earnings-card.tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function EarningsCard({ ticker }: { ticker: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Earnings history</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Earnings history for {ticker} arrives in a follow-up task. Last 8 quarters of EPS will appear here.
        </p>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Write `notes-editor.tsx`**

```tsx
// app/(app)/stock/[ticker]/_components/notes-editor.tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

export function NotesEditor({ ticker }: { ticker: string }) {
  const [body, setBody] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const timerRef = useRef<number | null>(null);

  // Load existing note.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/notes/${ticker}`)
      .then((r) => r.json())
      .then((d: { body: string }) => {
        if (!cancelled) {
          setBody(d.body);
          setLoaded(true);
        }
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  // Autosave on change with 1s debounce.
  useEffect(() => {
    if (!loaded) return;
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(async () => {
      setSaving(true);
      try {
        const res = await fetch(`/api/notes/${ticker}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body })
        });
        if (res.ok) setSavedAt(new Date());
      } finally {
        setSaving(false);
      }
    }, 1000);
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, [body, loaded, ticker]);

  if (!loaded) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <Tabs defaultValue="edit">
      <TabsList>
        <TabsTrigger value="edit">Edit</TabsTrigger>
        <TabsTrigger value="preview">Preview</TabsTrigger>
      </TabsList>
      <TabsContent value="edit">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          className="w-full bg-background border border-border rounded p-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder={`# ${ticker} thesis\n\nWhat I believe and why...`}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          {saving ? 'Saving…' : savedAt ? `Saved ${savedAt.toLocaleTimeString()}` : 'Autosaves on change'}
        </p>
      </TabsContent>
      <TabsContent value="preview">
        <div className="prose prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{body || '_Empty_'}</ReactMarkdown>
        </div>
      </TabsContent>
    </Tabs>
  );
}
```

(`prose prose-invert` requires `@tailwindcss/typography`. Either install it now — `pnpm add -D @tailwindcss/typography` and add to the tailwind config — or drop the `prose` classes in favor of plain text. For Slice 1 simplicity, drop them.)

- [ ] **Step 6: Verify build**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm build 2>&1 | tail -15
```

- [ ] **Step 7: Browser smoke test**

`pnpm dev` → sign in → navigate to a seeded ticker (e.g., `/stock/AAPL`). Snapshot card should render with real numbers, sparkline should render, notes editor should load and autosave on changes.

- [ ] **Step 8: Commit everything for M8**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add app/\(app\)/stock/ package.json pnpm-lock.yaml
git commit -m "feat(ui): ticker dashboard with snapshot, sparkline, notes editor"
```

---

## Milestone 9: Financials tab

Goal: `/stock/[ticker]/financials` shows the 5Y statements table with annual/quarterly toggle plus revenue/margin/FCF charts.

### Task 9.1: Financials page + table

**Files:**
- Create: `app/(app)/stock/[ticker]/financials/page.tsx`
- Create: `app/(app)/stock/[ticker]/_components/financials-table.tsx`

- [ ] **Step 1: Write the page**

```tsx
// app/(app)/stock/[ticker]/financials/page.tsx
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { companies } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { FinancialsService } from '@/lib/services/financials';
import { loadServerEnv } from '@/lib/env';
import { FinancialsTable } from '../_components/financials-table';
import { RevenueChart } from '../_components/revenue-chart';
import { MarginChart } from '../_components/margin-chart';
import { FCFChart } from '../_components/fcf-chart';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const PERIODS = ['annual', 'quarterly'] as const;
type Period = (typeof PERIODS)[number];

interface PageProps {
  params: { ticker: string };
  searchParams: { period?: string };
}

export default async function FinancialsPage({ params, searchParams }: PageProps) {
  await requireUserId();
  const { ticker: raw } = params;
  const { period: paramPeriod } = searchParams;
  const ticker = raw.toUpperCase();
  if (!TICKER_RE.test(ticker)) notFound();

  const period: Period = PERIODS.includes(paramPeriod as Period)
    ? (paramPeriod as Period)
    : 'annual';

  const db = getServiceDb();
  const existing = await db.select().from(companies).where(eq(companies.ticker, ticker)).limit(1);
  if (existing.length === 0) notFound();

  const env = loadServerEnv();
  const svc = new FinancialsService({
    db,
    primary: new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY }),
    fallback: new YFinanceProvider(),
    redis: getRedisCache()
  });

  const [income, balance, cashFlow] = await Promise.all([
    svc.get(ticker, 'income', period).catch(() => ({ ticker, statementType: 'income' as const, periodType: period, rows: [] })),
    svc.get(ticker, 'balance', period).catch(() => ({ ticker, statementType: 'balance' as const, periodType: period, rows: [] })),
    svc.get(ticker, 'cash_flow', period).catch(() => ({ ticker, statementType: 'cash_flow' as const, periodType: period, rows: [] }))
  ]);

  return (
    <article className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{ticker}</h1>
          <p className="text-sm text-muted-foreground">{existing[0]!.name}</p>
        </div>
        <Tabs value="financials" className="hidden sm:block">
          <TabsList>
            <TabsTrigger value="overview" asChild>
              <Link href={`/stock/${ticker}`}>Overview</Link>
            </TabsTrigger>
            <TabsTrigger value="financials" asChild>
              <Link href={`/stock/${ticker}/financials`}>Financials</Link>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      <Tabs value={period}>
        <TabsList>
          <TabsTrigger value="annual" asChild>
            <Link href={`/stock/${ticker}/financials?period=annual`}>Annual</Link>
          </TabsTrigger>
          <TabsTrigger value="quarterly" asChild>
            <Link href={`/stock/${ticker}/financials?period=quarterly`}>Quarterly</Link>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader><CardTitle>Revenue</CardTitle></CardHeader>
          <CardContent><RevenueChart income={income} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Margins</CardTitle></CardHeader>
          <CardContent><MarginChart income={income} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Free cash flow</CardTitle></CardHeader>
          <CardContent><FCFChart cashFlow={cashFlow} /></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Income statement ({period})</CardTitle></CardHeader>
        <CardContent>
          <FinancialsTable bundle={income} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Balance sheet ({period})</CardTitle></CardHeader>
        <CardContent>
          <FinancialsTable bundle={balance} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Cash flow ({period})</CardTitle></CardHeader>
        <CardContent>
          <FinancialsTable bundle={cashFlow} />
        </CardContent>
      </Card>
    </article>
  );
}
```

- [ ] **Step 2: Write the table component**

```tsx
// app/(app)/stock/[ticker]/_components/financials-table.tsx
import type { StatementBundle } from '@/lib/providers/types';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { computeYoY } from '@/lib/compute/growth';

function fmtBillions(v: number | null) {
  if (v == null) return '—';
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  return v.toFixed(0);
}

function fmtPct(v: number | null) {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

export function FinancialsTable({ bundle }: { bundle: StatementBundle }) {
  if (bundle.rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No data.</p>;
  }
  // Pivot to wide: rows = unique line items, cols = periods (desc).
  const periods = Array.from(new Set(bundle.rows.map((r) => r.periodEnd))).sort().reverse().slice(0, 5);
  const lineItems = Array.from(new Set(bundle.rows.map((r) => r.lineItem)));

  function get(li: string, period: string): number | null {
    return bundle.rows.find((r) => r.lineItem === li && r.periodEnd === period)?.value ?? null;
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-48">Line item</TableHead>
            {periods.map((p) => (
              <TableHead key={p} className="text-right tabular-nums">{p}</TableHead>
            ))}
            <TableHead className="text-right">YoY</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lineItems.map((li) => {
            const cur = get(li, periods[0]!);
            const prev = periods.length >= 2 ? get(li, periods[1]!) : null;
            const yoy = computeYoY(cur, prev);
            return (
              <TableRow key={li}>
                <TableCell className="font-medium">{li.replace(/_/g, ' ')}</TableCell>
                {periods.map((p) => (
                  <TableCell key={p} className="text-right tabular-nums">
                    {fmtBillions(get(li, p))}
                  </TableCell>
                ))}
                <TableCell className="text-right tabular-nums">{fmtPct(yoy)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 3: Commit (no charts yet — page won't build)**

Skip commit. Charts land in 9.2.

---

### Task 9.2: Revenue, margin, FCF charts

**Files:**
- Create: `app/(app)/stock/[ticker]/_components/revenue-chart.tsx`
- Create: `app/(app)/stock/[ticker]/_components/margin-chart.tsx`
- Create: `app/(app)/stock/[ticker]/_components/fcf-chart.tsx`

- [ ] **Step 1: Revenue chart**

```tsx
// app/(app)/stock/[ticker]/_components/revenue-chart.tsx
'use client';

import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';
import type { StatementBundle } from '@/lib/providers/types';

export function RevenueChart({ income }: { income: StatementBundle }) {
  const data = Array.from(new Set(income.rows.map((r) => r.periodEnd)))
    .sort()
    .map((period) => {
      const rev = income.rows.find((r) => r.lineItem === 'revenue' && r.periodEnd === period)?.value ?? null;
      return { period, revenue: rev ?? 0 };
    });

  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">No data.</p>;
  }

  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <XAxis dataKey="period" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
          <YAxis hide />
          <Tooltip
            contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontSize: 12 }}
            formatter={(v: number) => `$${(v / 1e9).toFixed(1)}B`}
          />
          <Bar dataKey="revenue" fill="hsl(var(--primary))" radius={2} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 2: Margin chart**

```tsx
// app/(app)/stock/[ticker]/_components/margin-chart.tsx
'use client';

import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import type { StatementBundle } from '@/lib/providers/types';

export function MarginChart({ income }: { income: StatementBundle }) {
  const periods = Array.from(new Set(income.rows.map((r) => r.periodEnd))).sort();
  const data = periods.map((period) => {
    const rev = income.rows.find((r) => r.lineItem === 'revenue' && r.periodEnd === period)?.value ?? null;
    const gross = income.rows.find((r) => r.lineItem === 'gross_profit' && r.periodEnd === period)?.value ?? null;
    const op = income.rows.find((r) => r.lineItem === 'operating_income' && r.periodEnd === period)?.value ?? null;
    return {
      period,
      gross: rev && gross ? (gross / rev) * 100 : null,
      operating: rev && op ? (op / rev) * 100 : null
    };
  });

  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">No data.</p>;
  }

  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <XAxis dataKey="period" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
          <YAxis unit="%" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
          <Tooltip
            contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontSize: 12 }}
            formatter={(v: number) => `${v?.toFixed?.(1) ?? '—'}%`}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line type="monotone" dataKey="gross" stroke="hsl(var(--primary))" name="Gross" dot={false} />
          <Line type="monotone" dataKey="operating" stroke="hsl(var(--accent-foreground))" name="Operating" dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 3: FCF chart**

```tsx
// app/(app)/stock/[ticker]/_components/fcf-chart.tsx
'use client';

import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';
import type { StatementBundle } from '@/lib/providers/types';

export function FCFChart({ cashFlow }: { cashFlow: StatementBundle }) {
  const data = Array.from(new Set(cashFlow.rows.map((r) => r.periodEnd)))
    .sort()
    .map((period) => {
      const fcf = cashFlow.rows.find((r) => r.lineItem === 'free_cash_flow' && r.periodEnd === period)?.value;
      const ocf = cashFlow.rows.find((r) => r.lineItem === 'operating_cash_flow' && r.periodEnd === period)?.value;
      const capex = cashFlow.rows.find((r) => r.lineItem === 'capital_expenditure' && r.periodEnd === period)?.value;
      // If free_cash_flow is missing but OCF + capex are present, derive it.
      const derived = ocf != null && capex != null ? ocf + capex : null;
      return { period, fcf: (fcf ?? derived) ?? 0 };
    });

  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">No data.</p>;
  }

  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <XAxis dataKey="period" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
          <YAxis hide />
          <Tooltip
            contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontSize: 12 }}
            formatter={(v: number) => `$${(v / 1e9).toFixed(1)}B`}
          />
          <Bar dataKey="fcf" fill="hsl(var(--primary))" radius={2} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 4: Verify build**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm build 2>&1 | tail -15
```

- [ ] **Step 5: Browser smoke test**

`pnpm dev` → navigate to `/stock/AAPL/financials`. Should show income/balance/cash-flow tables + three charts. Toggle annual/quarterly works.

- [ ] **Step 6: Commit M9 in one go**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add app/\(app\)/stock/\[ticker\]/financials/ app/\(app\)/stock/\[ticker\]/_components/financials-table.tsx app/\(app\)/stock/\[ticker\]/_components/revenue-chart.tsx app/\(app\)/stock/\[ticker\]/_components/margin-chart.tsx app/\(app\)/stock/\[ticker\]/_components/fcf-chart.tsx
git commit -m "feat(ui): financials tab with statements table + 3 charts"
```

---

## Milestone 10: Add ticker flow

Goal: `?add=1` query param on `/watchlist` opens a shadcn dialog; submitting the ticker calls the API and navigates to the new ticker on success.

### Task 10.1: Add-ticker dialog

**Files:**
- Create: `app/(app)/watchlist/_components/add-ticker-dialog.tsx`
- Modify: `app/(app)/watchlist/page.tsx` (mount the dialog conditionally)

- [ ] **Step 1: Write the dialog**

```tsx
// app/(app)/watchlist/_components/add-ticker-dialog.tsx
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

export function AddTickerDialog() {
  const router = useRouter();
  const params = useSearchParams();
  const open = params.get('add') === '1';

  const [ticker, setTicker] = useState('');
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  function close() {
    const p = new URLSearchParams(params);
    p.delete('add');
    router.push(`/watchlist${p.toString() ? '?' + p.toString() : ''}`);
  }

  async function submit() {
    const sym = ticker.toUpperCase().trim();
    if (!TICKER_RE.test(sym)) {
      toast({ title: 'Invalid ticker', description: 'Use 1–6 uppercase letters (optionally with dots).', variant: 'destructive' });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/tickers/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: sym })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        toast({ title: 'Could not add ticker', description: body.error ?? `HTTP ${res.status}`, variant: 'destructive' });
        return;
      }
      const data = (await res.json()) as { redirectTo?: string };
      toast({ title: `${sym} added to watchlist` });
      router.push(data.redirectTo ?? `/stock/${sym}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add ticker</DialogTitle>
          <DialogDescription>
            Enter a US-listed symbol. We'll ingest snapshot, financials, and prices, then add it to your watchlist.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={ticker}
          onChange={(e) => setTicker(e.target.value)}
          placeholder="AAPL"
          autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? 'Adding…' : 'Add'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Mount the dialog on the watchlist page**

Edit `app/(app)/watchlist/page.tsx` and add at the bottom of the `WatchlistPage` return, right above the closing `</section>` (also handle the empty-state path):

```tsx
import { AddTickerDialog } from './_components/add-ticker-dialog';
// ... in the function body:
return (
  <>
    {/* existing watchlist UI or empty state */}
    <AddTickerDialog />
  </>
);
```

Adjust the two return branches to wrap each in a fragment with `<AddTickerDialog />` appended.

- [ ] **Step 3: Verify build**

- [ ] **Step 4: Browser smoke test**

`pnpm dev` → `/watchlist?add=1` → dialog opens. Type "TSLA" → submit. After 3-5s, lands at `/stock/TSLA` with real data.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add app/\(app\)/watchlist/
git commit -m "feat(ui): add-ticker dialog with on-demand ingest"
```

---

## Milestone 11: Analytics cards — Returns, Growth, Valuation, Earnings

Goal: close the remaining Slice 1 spec items by adding four analytics cards to the ticker dashboard. Compute functions from Phase 1A M3 (`multiples.ts`, `growth.ts`, `returns.ts`) are the engine; this milestone is mostly thin presentational wrappers + small server-side computation helpers.

### Task 11.1: ReturnsCard — ROE, ROA, margins over 5Y

**Files:**
- Create: `lib/compute/dashboard.ts`
- Create: `app/(app)/stock/[ticker]/_components/returns-card.tsx`
- Create: `tests/compute/dashboard.test.ts`

`lib/compute/dashboard.ts` will hold pure functions that take raw fundamentals rows and return the shape each card consumes. Heavily unit-testable.

- [ ] **Step 1: Write the failing unit test**

```ts
// tests/compute/dashboard.test.ts
import { describe, it, expect } from 'vitest';
import { buildReturnsSeries } from '@/lib/compute/dashboard';
import type { FundamentalRow } from '@/lib/providers/types';

function row(periodEnd: string, lineItem: string, value: number): FundamentalRow {
  return { periodEnd, lineItem, value, currency: 'USD' };
}

describe('buildReturnsSeries', () => {
  it('computes ROE, ROA, and margins per year', () => {
    const income = [
      row('2024-09-30', 'revenue', 1000),
      row('2024-09-30', 'gross_profit', 400),
      row('2024-09-30', 'operating_income', 200),
      row('2024-09-30', 'net_income', 100),
      row('2023-09-30', 'revenue', 800),
      row('2023-09-30', 'gross_profit', 320),
      row('2023-09-30', 'operating_income', 160),
      row('2023-09-30', 'net_income', 80)
    ];
    const balance = [
      row('2024-09-30', 'total_assets', 2000),
      row('2024-09-30', 'total_equity', 500),
      row('2023-09-30', 'total_assets', 1800),
      row('2023-09-30', 'total_equity', 400)
    ];

    const out = buildReturnsSeries(income, balance);

    expect(out).toHaveLength(2);
    expect(out[0]!.periodEnd).toBe('2024-09-30'); // newest first
    expect(out[0]!.roe).toBeCloseTo(0.2);          // 100/500
    expect(out[0]!.roa).toBeCloseTo(0.05);          // 100/2000
    expect(out[0]!.grossMargin).toBeCloseTo(0.4);   // 400/1000
    expect(out[0]!.operatingMargin).toBeCloseTo(0.2); // 200/1000
    expect(out[0]!.netMargin).toBeCloseTo(0.1);     // 100/1000
  });

  it('returns null for any metric whose inputs are missing', () => {
    const income = [row('2024-09-30', 'revenue', 1000)];
    const out = buildReturnsSeries(income, []);
    expect(out[0]!.roe).toBeNull();
    expect(out[0]!.roa).toBeNull();
    expect(out[0]!.grossMargin).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test tests/compute/dashboard.test.ts
```

- [ ] **Step 3: Write `lib/compute/dashboard.ts`**

```ts
import type { FundamentalRow } from '@/lib/providers/types';
import { computeROE, computeROA } from '@/lib/compute/returns';

export interface ReturnsPoint {
  periodEnd: string;
  roe: number | null;
  roa: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
}

function findValue(rows: FundamentalRow[], periodEnd: string, lineItem: string): number | null {
  return rows.find((r) => r.periodEnd === periodEnd && r.lineItem === lineItem)?.value ?? null;
}

/**
 * Build a per-period series of returns + margins, newest first.
 * Joins income and balance bundles on periodEnd; periods missing from either
 * side appear with nulls where data is absent.
 */
export function buildReturnsSeries(
  income: FundamentalRow[],
  balance: FundamentalRow[]
): ReturnsPoint[] {
  const periods = Array.from(
    new Set([...income.map((r) => r.periodEnd), ...balance.map((r) => r.periodEnd)])
  )
    .sort()
    .reverse()
    .slice(0, 5);

  return periods.map((periodEnd) => {
    const revenue = findValue(income, periodEnd, 'revenue');
    const grossProfit = findValue(income, periodEnd, 'gross_profit');
    const operatingIncome = findValue(income, periodEnd, 'operating_income');
    const netIncome = findValue(income, periodEnd, 'net_income');
    const totalEquity = findValue(balance, periodEnd, 'total_equity');
    const totalAssets = findValue(balance, periodEnd, 'total_assets');

    return {
      periodEnd,
      roe: computeROE(netIncome, totalEquity),
      roa: computeROA(netIncome, totalAssets),
      grossMargin: revenue && grossProfit != null ? grossProfit / revenue : null,
      operatingMargin: revenue && operatingIncome != null ? operatingIncome / revenue : null,
      netMargin: revenue && netIncome != null ? netIncome / revenue : null
    };
  });
}
```

- [ ] **Step 4: Run, verify passes**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test tests/compute/dashboard.test.ts
```

- [ ] **Step 5: Write the card component**

```tsx
// app/(app)/stock/[ticker]/_components/returns-card.tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ReturnsPoint } from '@/lib/compute/dashboard';

function fmtPct(v: number | null) {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

export function ReturnsCard({ series }: { series: ReturnsPoint[] }) {
  if (series.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle>Profitability & returns</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">No data.</p></CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader><CardTitle>Profitability & returns (5Y)</CardTitle></CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">Metric</TableHead>
              {series.map((p) => (
                <TableHead key={p.periodEnd} className="text-right tabular-nums">
                  {p.periodEnd.slice(0, 7)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {[
              { label: 'ROE', key: 'roe' },
              { label: 'ROA', key: 'roa' },
              { label: 'Gross margin', key: 'grossMargin' },
              { label: 'Operating margin', key: 'operatingMargin' },
              { label: 'Net margin', key: 'netMargin' }
            ].map(({ label, key }) => (
              <TableRow key={key}>
                <TableCell className="font-medium">{label}</TableCell>
                {series.map((p) => (
                  <TableCell key={p.periodEnd} className="text-right tabular-nums">
                    {fmtPct((p as Record<string, number | null>)[key] ?? null)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="mt-3 text-xs text-muted-foreground">
          ROIC is deferred to Slice 1.5 (requires pretax-income data not in the current schema).
        </p>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add lib/compute/dashboard.ts tests/compute/dashboard.test.ts app/\(app\)/stock/\[ticker\]/_components/returns-card.tsx
git commit -m "feat(ui): ReturnsCard with 5Y ROE/ROA + margins from fundamentals"
```

---

### Task 11.2: GrowthCard — CAGR over 3Y and 5Y

**Files:**
- Modify: `lib/compute/dashboard.ts` (append `buildGrowthSummary`)
- Create: `app/(app)/stock/[ticker]/_components/growth-card.tsx`
- Append to: `tests/compute/dashboard.test.ts`

- [ ] **Step 1: Append failing test**

```ts
import { buildGrowthSummary } from '@/lib/compute/dashboard';

describe('buildGrowthSummary', () => {
  it('computes 3Y and 5Y CAGR for revenue, EPS, and FCF', () => {
    const income = [
      row('2024-09-30', 'revenue', 1610), // 2024
      row('2023-09-30', 'revenue', 1400), // 2023
      row('2022-09-30', 'revenue', 1210), // 2022 — 3Y start vs 2024
      row('2021-09-30', 'revenue', 1100),
      row('2019-09-30', 'revenue', 1000), // 5Y start
      row('2024-09-30', 'earnings_per_share', 6.16),
      row('2019-09-30', 'earnings_per_share', 3.0)
    ];
    const cashFlow = [
      row('2024-09-30', 'free_cash_flow', 150),
      row('2019-09-30', 'free_cash_flow', 100)
    ];

    const out = buildGrowthSummary(income, cashFlow);

    // 1610 / 1210 over 2y → (1610/1210)^(1/2) - 1 = ~0.154
    expect(out.revenueCAGR3Y).toBeCloseTo(0.154, 2);
    // 1610 / 1000 over 5y → (1610/1000)^(1/5) - 1 = ~0.100
    expect(out.revenueCAGR5Y).toBeCloseTo(0.0998, 2);
    expect(out.epsCAGR5Y).toBeCloseTo(0.155, 2); // (6.16/3)^(1/5) - 1
    expect(out.fcfCAGR5Y).toBeCloseTo(0.0845, 2); // (150/100)^(1/5) - 1
  });

  it('returns null when not enough history is available', () => {
    const income = [row('2024-09-30', 'revenue', 1000)];
    const out = buildGrowthSummary(income, []);
    expect(out.revenueCAGR3Y).toBeNull();
    expect(out.revenueCAGR5Y).toBeNull();
  });
});
```

- [ ] **Step 2: Append `buildGrowthSummary` to `lib/compute/dashboard.ts`**

```ts
import { computeCAGR } from '@/lib/compute/growth';

export interface GrowthSummary {
  revenueCAGR3Y: number | null;
  revenueCAGR5Y: number | null;
  epsCAGR3Y: number | null;
  epsCAGR5Y: number | null;
  fcfCAGR3Y: number | null;
  fcfCAGR5Y: number | null;
}

function periodEndYearsAgo(rows: FundamentalRow[], lineItem: string, years: number): number | null {
  const periods = rows
    .filter((r) => r.lineItem === lineItem)
    .map((r) => ({ periodEnd: r.periodEnd, value: r.value }))
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))
    .reverse();
  if (periods.length === 0) return null;
  // Index `years` back from the most recent period.
  const target = periods[years];
  return target?.value ?? null;
}

function mostRecent(rows: FundamentalRow[], lineItem: string): number | null {
  const sorted = rows
    .filter((r) => r.lineItem === lineItem)
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  return sorted[0]?.value ?? null;
}

export function buildGrowthSummary(
  income: FundamentalRow[],
  cashFlow: FundamentalRow[]
): GrowthSummary {
  const cagr = (end: number | null, start: number | null, years: number) =>
    computeCAGR(end, start, years);

  return {
    revenueCAGR3Y: cagr(mostRecent(income, 'revenue'), periodEndYearsAgo(income, 'revenue', 3), 3),
    revenueCAGR5Y: cagr(mostRecent(income, 'revenue'), periodEndYearsAgo(income, 'revenue', 5), 5),
    epsCAGR3Y: cagr(mostRecent(income, 'earnings_per_share'), periodEndYearsAgo(income, 'earnings_per_share', 3), 3),
    epsCAGR5Y: cagr(mostRecent(income, 'earnings_per_share'), periodEndYearsAgo(income, 'earnings_per_share', 5), 5),
    fcfCAGR3Y: cagr(mostRecent(cashFlow, 'free_cash_flow'), periodEndYearsAgo(cashFlow, 'free_cash_flow', 3), 3),
    fcfCAGR5Y: cagr(mostRecent(cashFlow, 'free_cash_flow'), periodEndYearsAgo(cashFlow, 'free_cash_flow', 5), 5)
  };
}
```

- [ ] **Step 3: Run tests**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test tests/compute/dashboard.test.ts
```

- [ ] **Step 4: Write the card**

```tsx
// app/(app)/stock/[ticker]/_components/growth-card.tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { GrowthSummary } from '@/lib/compute/dashboard';

function fmtPct(v: number | null) {
  if (v == null) return '—';
  const pct = (v * 100).toFixed(1);
  return v >= 0 ? `+${pct}%` : `${pct}%`;
}

export function GrowthCard({ growth }: { growth: GrowthSummary }) {
  const rows: Array<{ label: string; threeY: number | null; fiveY: number | null }> = [
    { label: 'Revenue', threeY: growth.revenueCAGR3Y, fiveY: growth.revenueCAGR5Y },
    { label: 'EPS', threeY: growth.epsCAGR3Y, fiveY: growth.epsCAGR5Y },
    { label: 'FCF', threeY: growth.fcfCAGR3Y, fiveY: growth.fcfCAGR5Y }
  ];
  return (
    <Card>
      <CardHeader><CardTitle>Growth (CAGR)</CardTitle></CardHeader>
      <CardContent>
        <dl className="grid grid-cols-3 gap-x-4 gap-y-3 text-sm">
          <dt className="text-muted-foreground">Metric</dt>
          <dt className="text-muted-foreground text-right">3Y</dt>
          <dt className="text-muted-foreground text-right">5Y</dt>
          {rows.map((r) => (
            <div key={r.label} className="contents">
              <dd className="font-medium">{r.label}</dd>
              <dd className="text-right tabular-nums">{fmtPct(r.threeY)}</dd>
              <dd className="text-right tabular-nums">{fmtPct(r.fiveY)}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add lib/compute/dashboard.ts tests/compute/dashboard.test.ts app/\(app\)/stock/\[ticker\]/_components/growth-card.tsx
git commit -m "feat(ui): GrowthCard with 3Y/5Y CAGR for revenue, EPS, FCF"
```

---

### Task 11.3: ValuationCard — current vs 5Y avg multiples

**Files:**
- Modify: `lib/compute/dashboard.ts` (append `buildValuationSummary`)
- Create: `app/(app)/stock/[ticker]/_components/valuation-card.tsx`
- Append to: `tests/compute/dashboard.test.ts`

Constraint: we only have current snapshot data + historical EPS + historical prices. P/E is reconstructible from these (year-end price ÷ that year's EPS). P/S, P/B, EV/EBITDA require shares outstanding which we don't store yet — show current only, with a note.

- [ ] **Step 1: Append failing test**

```ts
import { buildValuationSummary } from '@/lib/compute/dashboard';
import type { PricePoint } from '@/lib/providers/types';

function price(date: string, close: number): PricePoint {
  return { date, open: null, high: null, low: null, close, adjClose: close, volume: null };
}

describe('buildValuationSummary', () => {
  it('computes current P/E and 5Y average P/E from EPS + year-end prices', () => {
    const income = [
      row('2024-09-30', 'earnings_per_share', 6.0),
      row('2023-09-30', 'earnings_per_share', 5.0),
      row('2022-09-30', 'earnings_per_share', 4.0),
      row('2021-09-30', 'earnings_per_share', 3.0),
      row('2020-09-30', 'earnings_per_share', 2.0)
    ];
    const prices = [
      price('2024-09-27', 180), // P/E = 30
      price('2023-09-29', 150), // P/E = 30
      price('2022-09-30', 120), // P/E = 30
      price('2021-09-30', 90),  // P/E = 30
      price('2020-09-30', 60)   // P/E = 30
    ];
    const out = buildValuationSummary({ pe: 35, ps: 7.8, pb: 45.2, evEbitda: 22.1, peg: 2.4 }, income, prices);
    expect(out.currentPE).toBe(35);
    expect(out.avgPE5Y).toBeCloseTo(30, 0);
    expect(out.currentPS).toBe(7.8);
    expect(out.avgPS5Y).toBeNull(); // no historical computation possible
  });

  it('skips years with missing EPS or no nearby price', () => {
    const income = [row('2024-09-30', 'earnings_per_share', 6.0)];
    const prices = [price('2024-09-27', 180)];
    const out = buildValuationSummary({ pe: 30 }, income, prices);
    expect(out.avgPE5Y).toBeCloseTo(30); // average of just one year
  });
});
```

- [ ] **Step 2: Append to `lib/compute/dashboard.ts`**

```ts
import type { PricePoint } from '@/lib/providers/types';

export interface CurrentMultiples {
  pe?: number | null;
  ps?: number | null;
  pb?: number | null;
  evEbitda?: number | null;
  peg?: number | null;
}

export interface ValuationSummary {
  currentPE: number | null;
  avgPE5Y: number | null;
  currentPS: number | null;
  avgPS5Y: number | null;   // always null in Slice 1 — no historical shares-outstanding data
  currentPB: number | null;
  avgPB5Y: number | null;   // same
  currentEvEbitda: number | null;
  avgEvEbitda5Y: number | null; // same
  currentPEG: number | null;
}

function findClosestPrice(prices: PricePoint[], target: string): number | null {
  if (prices.length === 0) return null;
  const targetMs = Date.parse(target);
  if (isNaN(targetMs)) return null;
  let best: PricePoint | null = null;
  let bestDelta = Infinity;
  for (const p of prices) {
    const delta = Math.abs(Date.parse(p.date) - targetMs);
    if (delta < bestDelta) {
      best = p;
      bestDelta = delta;
    }
  }
  // Require the closest price to be within 30 days of the target.
  return best && bestDelta <= 30 * 24 * 60 * 60 * 1000 ? best.close : null;
}

export function buildValuationSummary(
  current: CurrentMultiples,
  income: FundamentalRow[],
  prices: PricePoint[]
): ValuationSummary {
  const epsByPeriod = income
    .filter((r) => r.lineItem === 'earnings_per_share' && r.value != null)
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))
    .slice(0, 5);

  const historicalPEs: number[] = [];
  for (const { periodEnd, value: eps } of epsByPeriod) {
    if (eps == null || eps <= 0) continue;
    const price = findClosestPrice(prices, periodEnd);
    if (price == null) continue;
    historicalPEs.push(price / eps);
  }
  const avgPE5Y =
    historicalPEs.length > 0
      ? historicalPEs.reduce((a, b) => a + b, 0) / historicalPEs.length
      : null;

  return {
    currentPE: current.pe ?? null,
    avgPE5Y,
    currentPS: current.ps ?? null,
    avgPS5Y: null,
    currentPB: current.pb ?? null,
    avgPB5Y: null,
    currentEvEbitda: current.evEbitda ?? null,
    avgEvEbitda5Y: null,
    currentPEG: current.peg ?? null
  };
}
```

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Write the card**

```tsx
// app/(app)/stock/[ticker]/_components/valuation-card.tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ValuationSummary } from '@/lib/compute/dashboard';

function fmtMultiple(v: number | null) {
  if (v == null) return '—';
  return v.toFixed(1) + '×';
}

function delta(curr: number | null, avg: number | null): string {
  if (curr == null || avg == null) return '';
  const d = ((curr - avg) / avg) * 100;
  const sign = d >= 0 ? '+' : '';
  return ` (${sign}${d.toFixed(0)}% vs avg)`;
}

export function ValuationCard({ valuation }: { valuation: ValuationSummary }) {
  const rows: Array<{ label: string; current: number | null; avg: number | null }> = [
    { label: 'P/E', current: valuation.currentPE, avg: valuation.avgPE5Y },
    { label: 'P/S', current: valuation.currentPS, avg: valuation.avgPS5Y },
    { label: 'P/B', current: valuation.currentPB, avg: valuation.avgPB5Y },
    { label: 'EV/EBITDA', current: valuation.currentEvEbitda, avg: valuation.avgEvEbitda5Y },
    { label: 'PEG', current: valuation.currentPEG, avg: null }
  ];
  return (
    <Card>
      <CardHeader><CardTitle>Valuation</CardTitle></CardHeader>
      <CardContent>
        <dl className="space-y-2 text-sm">
          {rows.map((r) => (
            <div key={r.label} className="flex justify-between items-baseline">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd className="font-semibold tabular-nums">
                {fmtMultiple(r.current)}
                <span className="ml-1 text-xs text-muted-foreground font-normal">
                  {delta(r.current, r.avg)}
                </span>
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">
          5Y averages for P/S, P/B, EV/EBITDA require historical shares-outstanding data, deferred to Slice 1.5.
        </p>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add lib/compute/dashboard.ts tests/compute/dashboard.test.ts app/\(app\)/stock/\[ticker\]/_components/valuation-card.tsx
git commit -m "feat(ui): ValuationCard with current vs 5Y avg P/E"
```

---

### Task 11.4: EarningsCard — real 8Q EPS

**Files:**
- Modify: `app/(app)/stock/[ticker]/_components/earnings-card.tsx` (replace stub)

The `earnings` table in Phase 1A is sparse (many tickers had no historical earnings data from FD free tier or yfinance). Render what we have; graceful "no data" otherwise.

- [ ] **Step 1: Replace `earnings-card.tsx` with the real implementation**

```tsx
// app/(app)/stock/[ticker]/_components/earnings-card.tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getServiceDb } from '@/lib/db/client';
import { earnings as earningsTable } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';

function fmtEps(v: string | null): string {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toFixed(2)}`;
}

function fmtDate(d: string): string {
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export async function EarningsCard({ ticker }: { ticker: string }) {
  const db = getServiceDb();
  const rows = await db
    .select()
    .from(earningsTable)
    .where(eq(earningsTable.ticker, ticker))
    .orderBy(desc(earningsTable.periodEnd))
    .limit(8);

  return (
    <Card>
      <CardHeader><CardTitle>Earnings (last 8Q)</CardTitle></CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No earnings history for {ticker} yet. Will populate after the next cron run.
          </p>
        ) : (
          <ol className="space-y-2 text-sm">
            {rows.map((r) => (
              <li key={r.periodEnd} className="flex justify-between items-baseline">
                <span className="text-muted-foreground">{r.periodEnd}</span>
                <span className="tabular-nums font-medium">{fmtEps(r.epsActual)}</span>
                {r.reportedDate && (
                  <span className="text-xs text-muted-foreground">
                    Reported {fmtDate(r.reportedDate)}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Consensus EPS + price reaction land in Slice 1.5 (requires paid estimates API).
        </p>
      </CardContent>
    </Card>
  );
}
```

This is now an async server component — Next.js 14 RSC supports `async` components fine.

- [ ] **Step 2: Verify build**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm build 2>&1 | tail -10
```

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add app/\(app\)/stock/\[ticker\]/_components/earnings-card.tsx
git commit -m "feat(ui): EarningsCard with real 8Q EPS from DB"
```

---

### Task 11.5: Mount Returns/Growth/Valuation/Earnings on the dashboard

**Files:**
- Modify: `app/(app)/stock/[ticker]/page.tsx`

- [ ] **Step 1: Replace the dashboard layout**

Open `app/(app)/stock/[ticker]/page.tsx` and replace its body with this layout:

```tsx
// app/(app)/stock/[ticker]/page.tsx
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { companies } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { SnapshotService } from '@/lib/services/snapshot';
import { PricesService } from '@/lib/services/prices';
import { FinancialsService } from '@/lib/services/financials';
import { loadServerEnv } from '@/lib/env';
import {
  buildReturnsSeries,
  buildGrowthSummary,
  buildValuationSummary
} from '@/lib/compute/dashboard';
import { SnapshotCard } from './_components/snapshot-card';
import { Sparkline } from './_components/sparkline';
import { ReturnsCard } from './_components/returns-card';
import { GrowthCard } from './_components/growth-card';
import { ValuationCard } from './_components/valuation-card';
import { EarningsCard } from './_components/earnings-card';
import { NotesEditor } from './_components/notes-editor';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface PageProps {
  params: { ticker: string };
}

export default async function StockPage({ params }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  if (!TICKER_RE.test(ticker)) notFound();

  const db = getServiceDb();
  const existing = await db.select().from(companies).where(eq(companies.ticker, ticker)).limit(1);
  if (existing.length === 0) notFound();

  const env = loadServerEnv();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const yf = new YFinanceProvider();
  const redis = getRedisCache();
  const snapshotSvc = new SnapshotService({ db, primary: fd, fallback: yf, redis });
  const pricesSvc = new PricesService({ db, primary: fd, fallback: yf, redis });
  const financialsSvc = new FinancialsService({ db, primary: fd, fallback: yf, redis });

  const [snapshot, prices5Y, incomeBundle, balanceBundle, cashFlowBundle] = await Promise.all([
    snapshotSvc.get(ticker).catch(() => null),
    pricesSvc.get(ticker, '5Y').catch(() => []),
    financialsSvc.get(ticker, 'income', 'annual').catch(() => ({ ticker, statementType: 'income' as const, periodType: 'annual' as const, rows: [] })),
    financialsSvc.get(ticker, 'balance', 'annual').catch(() => ({ ticker, statementType: 'balance' as const, periodType: 'annual' as const, rows: [] })),
    financialsSvc.get(ticker, 'cash_flow', 'annual').catch(() => ({ ticker, statementType: 'cash_flow' as const, periodType: 'annual' as const, rows: [] }))
  ]);

  const returnsSeries = buildReturnsSeries(incomeBundle.rows, balanceBundle.rows);
  const growthSummary = buildGrowthSummary(incomeBundle.rows, cashFlowBundle.rows);
  const valuationSummary = buildValuationSummary(
    {
      pe: snapshot?.pe ?? null,
      ps: snapshot?.ps ?? null,
      pb: snapshot?.pb ?? null,
      evEbitda: snapshot?.evEbitda ?? null,
      peg: snapshot?.peg ?? null
    },
    incomeBundle.rows,
    prices5Y
  );

  // Sparkline only needs 1Y; slice from 5Y to avoid an extra query.
  const oneYearAgoMs = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const prices1Y = prices5Y.filter((p) => Date.parse(p.date) >= oneYearAgoMs);

  return (
    <article className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{ticker}</h1>
          <p className="text-sm text-muted-foreground">{existing[0]!.name}</p>
        </div>
        <Tabs value="overview" className="hidden sm:block">
          <TabsList>
            <TabsTrigger value="overview" asChild>
              <Link href={`/stock/${ticker}`}>Overview</Link>
            </TabsTrigger>
            <TabsTrigger value="financials" asChild>
              <Link href={`/stock/${ticker}/financials`}>Financials</Link>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Snapshot</CardTitle></CardHeader>
          <CardContent>
            <SnapshotCard snapshot={snapshot} />
            <Sparkline data={prices1Y} />
          </CardContent>
        </Card>
        <ValuationCard valuation={valuationSummary} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <GrowthCard growth={growthSummary} />
        <EarningsCard ticker={ticker} />
      </div>

      <ReturnsCard series={returnsSeries} />

      <Card>
        <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
        <CardContent><NotesEditor ticker={ticker} /></CardContent>
      </Card>
    </article>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm build 2>&1 | tail -15
```

- [ ] **Step 3: Browser smoke test**

`pnpm dev` → `/stock/AAPL` should now show: Snapshot (2 cols) + Valuation (1 col) in row 1; Growth + Earnings (2 cols each) in row 2; ReturnsCard full-width in row 3; Notes at the bottom. Numbers populated from real data.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git add app/\(app\)/stock/\[ticker\]/page.tsx
git commit -m "feat(ui): mount Returns, Growth, Valuation, Earnings cards on dashboard"
```

---

## Phase 1B — Completion checklist

- [ ] All unit tests pass: `pnpm test`
- [ ] All integration tests pass: `pnpm test:integration` (expect 28 from Phase 1A + ~16 new from this phase = ~44 total)
- [ ] Typecheck clean: `pnpm typecheck`
- [ ] Lint clean: `pnpm lint`
- [ ] `pnpm build` succeeds
- [ ] Manual smoke test passes:
  - Sign up via `/handler/signup`
  - See empty watchlist
  - Open add-ticker dialog, add `TSLA`
  - Land on `/stock/TSLA` with snapshot card showing real price + multiples
  - Sparkline renders
  - Notes editor saves on change
  - Navigate to `/stock/TSLA/financials` — three charts + three tables visible
  - Sign out → land on `/`
  - Sign in again → land back at `/watchlist` with TSLA there

When all boxes are checked, Phase 1B is complete and Phase 1C (Cron + CI + E2E) can be planned.

---

## Phase 1B — Deferred to Phase 1C

- Vercel Cron handler at `app/api/cron/refresh/route.ts`
- GitHub Actions CI
- Playwright E2E (signup → add → render flow)
- `/api/health` endpoint
- Stack Auth webhook for user-deletion cleanup
- Earnings card (Slice 1.5)
- Search/typeahead for tickers in the add dialog (Slice 1.5)
- Mobile breakpoints polish

These are tracked so they don't get lost; each lands in the phase it's tagged for.
