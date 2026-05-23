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
