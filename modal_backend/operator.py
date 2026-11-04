"""Read-only by default. Uses official SDK with the logged-in profile.

Recovery requires --recover-control-lock and the API deployment must already
be stopped. No automatic lock deletion or reservation refunds.
"""
import argparse
import json
import modal


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--recover-control-lock", action="store_true")
    args = parser.parse_args()
    state = modal.Dict.from_name("reel-studio-gpu-state")
    gpu = modal.Function.from_name("reel-studio-gpu", "gpu_job")
    stats = gpu.get_current_stats()
    ledger = state.get("ledger", {})
    jobs = list(ledger.get("jobs", {}).values())
    print(json.dumps({"gpuStats": {"runners": stats.num_total_runners, "runningInputs": stats.num_running_inputs, "backlog": stats.backlog},
                      "controlLock": state.get("control-lock", None),
                      "jobs": [{k: j.get(k) for k in ("id", "kind", "status", "estimatedCostUsd")} for j in jobs[-20:]]}))
    if args.recover_control_lock:
        api_stats = modal.Function.from_name("reel-studio-gpu", "api").get_current_stats()
        if api_stats.num_total_runners or api_stats.num_running_inputs or stats.num_running_inputs or stats.backlog:
            raise RuntimeError("Stop the API app and reconcile all active calls before removing the lock")
        if any(j["status"] not in {"completed", "failed", "cancelled"} for j in jobs):
            raise RuntimeError("Unreconciled jobs remain. Do not remove the lock or budget reservations")
        state.pop("control-lock", None)
        print("Control lock removed. Reservations preserved.")


if __name__ == "__main__":
    main()
