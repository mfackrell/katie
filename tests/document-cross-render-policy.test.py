import importlib.util
import pathlib
import unittest
p=pathlib.Path(__file__).resolve().parents[1]/'scripts/document-cross-render-investigation.py'
spec=importlib.util.spec_from_file_location('cross_render',p)
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class ConstraintSeparation(unittest.TestCase):
    def test_unspecified_is_not_one_page(self):
        self.assertEqual(m.page_constraint(None,1),'NOT_REQUESTED')
        self.assertEqual(m.page_constraint(None,2),'NOT_REQUESTED')
    def test_explicit_remains_exact(self):
        self.assertEqual(m.page_constraint(1,2),'FAIL')
        self.assertEqual(m.page_constraint(2,1),'FAIL')
        self.assertEqual(m.page_constraint(2,2),'PASS')
    def test_parity_is_separate_and_not_waived(self):
        self.assertEqual(m.parity([1,2,1]),'FAIL')
        self.assertEqual(m.parity([2,2,2]),'PASS')
        self.assertEqual(m.parity([1]),'PENDING')
    def test_invalid_page_requirement_rejected(self):
        for value in [0,-1,True,1.5,'1']:
            with self.assertRaises(ValueError):m.page_constraint(value,1)

if __name__=='__main__':unittest.main()
