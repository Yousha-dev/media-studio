import hashlib
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path

from verify_release import PLATFORMS, verify_release


def binary(goos, goarch):
    data = bytearray(128)
    if goos == 'windows':
        data[:2] = b'MZ'
        struct.pack_into('<I', data, 0x3c, 64)
        data[64:68] = b'PE\0\0'
        struct.pack_into('<H', data, 68, 0x8664 if goarch == 'amd64' else 0xaa64)
    elif goos == 'linux':
        data[:6] = b'\x7fELF\x02\x01'
        struct.pack_into('<H', data, 18, 62 if goarch == 'amd64' else 183)
    else:
        data[:4] = b'\xcf\xfa\xed\xfe'
        struct.pack_into('<I', data, 4, 0x1000007 if goarch == 'amd64' else 0x100000c)
    return data


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for (goos, goarch), extension in PLATFORMS.items():
            self.archive(goos, goarch, f'media-studio.{extension}', binary(goos, goarch))
        self.checksums()

    def archive(self, goos, goarch, member, data):
        with zipfile.ZipFile(self.root / f'media-studio_1.0.1_{goos}_{goarch}.zip', 'w') as zipped:
            zipped.writestr(member, data)

    def checksums(self):
        text = ''.join(f'{hashlib.sha256(file.read_bytes()).hexdigest()}  {file.name}\n' for file in sorted(self.root.glob('*.zip')))
        (self.root / 'checksums.txt').write_text(text)

    def test_complete_six_platform_release(self):
        self.assertEqual(len(verify_release(self.root, '1.0.1')), 6)

    def test_missing_windows_arm64_even_with_valid_remaining_checksums(self):
        (self.root / 'media-studio_1.0.1_windows_arm64.zip').unlink()
        self.checksums()
        with self.assertRaisesRegex(ValueError, 'windows_arm64'):
            verify_release(self.root, '1.0.1')

    def test_windows_arm64_cannot_contain_an_x64_binary(self):
        self.archive('windows', 'arm64', 'media-studio.dll', binary('windows', 'amd64'))
        self.checksums()
        with self.assertRaisesRegex(ValueError, 'architecture'):
            verify_release(self.root, '1.0.1')

    def test_modified_archive_fails_checksum(self):
        with (self.root / 'media-studio_1.0.1_windows_arm64.zip').open('ab') as file:
            file.write(b'changed')
        with self.assertRaisesRegex(ValueError, 'Checksum mismatch'):
            verify_release(self.root, '1.0.1')

    def test_nested_library_rejected(self):
        self.archive('windows', 'arm64', 'nested/media-studio.dll', binary('windows', 'arm64'))
        self.checksums()
        with self.assertRaisesRegex(ValueError, 'root-level'):
            verify_release(self.root, '1.0.1')


if __name__ == '__main__':
    unittest.main()
