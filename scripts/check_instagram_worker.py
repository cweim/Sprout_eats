#!/usr/bin/env python3
"""Check a local or remote Instagram worker endpoint."""

from __future__ import annotations

import argparse
import json

import requests


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker-url", required=True)
    parser.add_argument("--token", default="")
    parser.add_argument("--instagram-url", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    base_url = args.worker_url.rstrip("/")
    headers = {}
    if args.token:
        headers["Authorization"] = f"Bearer {args.token}"

    health = requests.get(f"{base_url}/health", headers=headers, timeout=10)
    health.raise_for_status()
    print("health:", health.json())

    response = requests.post(
        f"{base_url}/extract/instagram",
        json={"url": args.instagram_url},
        headers=headers,
        timeout=30,
    )
    response.raise_for_status()
    print(json.dumps(response.json(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
