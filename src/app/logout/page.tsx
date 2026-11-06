import { logoutAction } from "@/app/actions";
import { button, Card } from "@/components/ui";

export default function Logout() {
  return (
    <Card title="Sign out">
      <form action={logoutAction}>
        <button className={button}>Sign out</button>
      </form>
    </Card>
  );
}
