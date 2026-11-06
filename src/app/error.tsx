"use client";

// Generic error boundary: never shows error details to the user.
export default function Error({ reset }: { reset: () => void }) {
  return (
    <div className="text-center">
      <h1 className="mb-4 text-2xl font-bold text-red-500">Something went wrong.</h1>
      <button className="underline" onClick={reset}>Try again</button>
    </div>
  );
}
