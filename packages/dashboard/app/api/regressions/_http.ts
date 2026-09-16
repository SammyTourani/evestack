import {
  RegressionConflictError,
  RegressionInputError,
} from "@/lib/regressions";
import { jsonError } from "@/app/api/control/_http";
export function regressionError(error: unknown) {
  if (error instanceof RegressionConflictError)
    return jsonError(error.message, 409, "conflict");
  if (error instanceof RegressionInputError)
    return jsonError(error.message, 400, "bad_request");
  return jsonError(
    "Regression storage or task evidence is unavailable. The write is not confirmed; inspect the saved case before retrying.",
    503,
    "unavailable",
  );
}
