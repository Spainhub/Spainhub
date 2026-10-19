from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from app.core.config import get_settings


class DecryptionError(Exception):
    pass


def _fernet() -> MultiFernet:
    # Первый ключ шифрует, остальные только расшифровывают — так делается ротация ключей.
    keys = [k.strip() for k in get_settings().encryption_keys.split(",") if k.strip()]
    return MultiFernet([Fernet(k) for k in keys])


def encrypt(plaintext: str) -> bytes:
    return _fernet().encrypt(plaintext.encode())


def decrypt(ciphertext: bytes) -> str:
    try:
        return _fernet().decrypt(bytes(ciphertext)).decode()
    except InvalidToken as e:
        raise DecryptionError("Не удалось расшифровать токен (ключ изменён?)") from e
