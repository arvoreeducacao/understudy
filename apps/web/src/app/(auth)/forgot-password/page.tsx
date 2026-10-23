import { redirect } from "next/navigation";
import { ForgotPasswordForm } from "@/components/ForgotPasswordForm";
import { mailEnabled } from "@/lib/mail";

export default function ForgotPasswordPage() {
  if (!mailEnabled()) redirect("/sign-in");
  return <ForgotPasswordForm />;
}
