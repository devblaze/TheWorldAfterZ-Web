import Link from "next/link";

export default function NotFound() {
  return (
    <div className="text-center">
      <h1 className="mb-4 text-2xl font-bold text-amber-500">Nothing here but ash.</h1>
      <Link href="/" className="underline">Back to safety</Link>
    </div>
  );
}
