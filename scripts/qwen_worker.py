import argparse
import json
import sys
import threading
from pathlib import Path


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def normalize_messages(raw_messages):
    messages = []
    for item in raw_messages:
        role = item.get("role", "user")
        if role not in ("system", "user", "assistant"):
            role = "user"
        messages.append({"role": role, "content": item.get("content", "")})
    return messages


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    args = parser.parse_args()

    model_dir = Path(args.model_dir).resolve()
    if not model_dir.exists():
        emit({"type": "startup_error", "error": f"Qwen model directory not found: {model_dir}"})
        return 1

    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer
    except Exception as exc:
        emit({"type": "startup_error", "error": f"Missing Qwen Python dependency: {exc}"})
        return 1

    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        tokenizer = AutoTokenizer.from_pretrained(str(model_dir), trust_remote_code=True)
        model = AutoModelForCausalLM.from_pretrained(
            str(model_dir),
            torch_dtype="auto",
            trust_remote_code=True,
        )
        model.to(device)
        model.eval()
        if tokenizer.pad_token_id is None and tokenizer.eos_token_id is not None:
            tokenizer.pad_token_id = tokenizer.eos_token_id
    except Exception as exc:
        emit({"type": "startup_error", "error": f"Failed to load Qwen model: {exc}"})
        return 1

    emit({"type": "ready", "device": device, "model_dir": str(model_dir)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
            request_id = request["id"]
            messages = normalize_messages(request.get("messages", []))
            max_new_tokens = int(request.get("max_new_tokens", 768))
            temperature = float(request.get("temperature", 0.6))

            try:
                prompt = tokenizer.apply_chat_template(
                    messages,
                    tokenize=False,
                    add_generation_prompt=True,
                    enable_thinking=False,
                )
            except TypeError:
                prompt = tokenizer.apply_chat_template(
                    messages,
                    tokenize=False,
                    add_generation_prompt=True,
                )

            inputs = tokenizer([prompt], return_tensors="pt").to(device)
            streamer = TextIteratorStreamer(
                tokenizer,
                skip_prompt=True,
                skip_special_tokens=True,
            )

            errors = []

            def generate():
                try:
                    with torch.no_grad():
                        model.generate(
                            **inputs,
                            streamer=streamer,
                            max_new_tokens=max_new_tokens,
                            do_sample=temperature > 0,
                            temperature=temperature,
                            top_p=0.9,
                            pad_token_id=tokenizer.pad_token_id,
                        )
                except Exception as exc:
                    errors.append(str(exc))

            thread = threading.Thread(target=generate)
            thread.start()

            for chunk in streamer:
                if chunk:
                    emit({"id": request_id, "type": "chunk", "text": chunk})

            thread.join()
            if errors:
                emit({"id": request_id, "type": "error", "error": errors[0]})
            else:
                emit({"id": request_id, "type": "end"})
        except Exception as exc:
            emit({
                "id": request.get("id") if isinstance(locals().get("request"), dict) else None,
                "type": "error",
                "error": str(exc),
            })

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
