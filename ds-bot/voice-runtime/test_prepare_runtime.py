"""Preparation must never mark an incomplete or incompatible environment ready."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest


class PreparationTests(unittest.TestCase):
    def setUp(self):
        path = Path(__file__).with_name("prepare_runtime.py")
        self.assertTrue(path.is_file(), "DS Bot needs its own environment preparer")
        spec = importlib.util.spec_from_file_location("prepare_runtime", path)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def test_requires_supported_python_before_creating_environment(self):
        with self.assertRaisesRegex(RuntimeError, "python_312_required"):
            self.module.require_python((3, 14, 0))

    def test_failed_install_never_writes_ready_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            requirements = root / "requirements.txt"
            requirements.write_text("funasr==1.4.16\n", encoding="utf-8")
            def runner(command, **kwargs):
                if "pip" in command:
                    return subprocess.CompletedProcess(command, 1, "private output", "secret")
                return subprocess.CompletedProcess(command, 1, "", "")
            with self.assertRaisesRegex(RuntimeError, "dependency_install_failed"):
                self.module.prepare_environment(root / "env", requirements, runner=runner, creator=lambda *_: None)
            self.assertFalse((root / "env" / self.module.MANIFEST).exists())

    def test_existing_unverified_environment_is_repaired_before_ready(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            requirements = root / "requirements.txt"
            requirements.write_text("funasr==1.4.16\n", encoding="utf-8")
            calls = []
            def runner(command, **kwargs):
                calls.append(command)
                return subprocess.CompletedProcess(command, 0, "", "")
            self.module.prepare_environment(root / "env", requirements, runner=runner, creator=lambda path: path.mkdir(parents=True))
            self.assertTrue(any("pip" in command for command in calls))
            self.assertTrue((root / "env" / self.module.MANIFEST).is_file())
            install = next(command for command in calls if "install" in command)
            self.assertIn("--force-reinstall", install)

    def test_existing_importable_environment_recovers_missing_manifest_without_reinstall(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            requirements = root / "requirements.txt"
            requirements.write_text("funasr==1.4.16\n", encoding="utf-8")
            env = root / "env"
            python = self.module.environment_python(env)
            python.parent.mkdir(parents=True)
            python.write_text("placeholder", encoding="utf-8")
            calls = []
            def runner(command, **kwargs):
                calls.append(command)
                return subprocess.CompletedProcess(command, 0, "", "")
            self.module.prepare_environment(env, requirements, runner=runner, creator=lambda *_: self.fail("must not recreate a valid environment"))
            self.assertTrue((env / self.module.MANIFEST).is_file())
            self.assertFalse(any("install" in command for command in calls))


if __name__ == "__main__":
    unittest.main()
