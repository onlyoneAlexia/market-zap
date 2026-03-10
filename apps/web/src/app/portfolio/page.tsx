import { redirect } from "next/navigation";

export default function PortfolioPage() {
  redirect("/account?tab=positions");
}
