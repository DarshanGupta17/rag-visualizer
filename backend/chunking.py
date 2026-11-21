def chunk_text(text: str, chunk_size: int = 300, overlap: int = 50) -> list[dict]:
    text = text.strip()
    if not text:
        return []
    if overlap >= chunk_size:
        raise ValueError("Chunk overlap must be smaller than chunk size.")

    chunks = []
    start = 0
    length = len(text)

    while start < length:
        end = min(start + chunk_size, length)

        if end < length:
            window = text[start:end]
            cut = max(window.rfind(". "), window.rfind("\n"), window.rfind("? "), window.rfind("! "))
            if cut > chunk_size // 2:
                end = start + cut + 1
            else:
                space = window.rfind(" ")
                if space > chunk_size // 2:
                    end = start + space

        piece = text[start:end]
        lead = len(piece) - len(piece.lstrip())
        trail = len(piece) - len(piece.rstrip())
        if piece.strip():
            chunks.append({
                "chunk_id": len(chunks),
                "text": piece.strip(),
                "start": start + lead,
                "end": end - trail,
            })

        if end >= length:
            break
        start = max(end - overlap, start + 1)
        while start < end and text[start] not in " \n" and text[start - 1] not in " \n":
            start += 1

    return chunks
