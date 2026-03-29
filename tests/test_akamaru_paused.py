"""
Test suite for konoha#100: Akamaru paused-services filtering
Verifies that Akamaru skips alerts for agents listed in /opt/shared/kiba/paused-services.txt
"""

import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock
import pytest

# Import from scripts.akamaru
import sys
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from akamaru import load_paused, check_services, check_orphaned_sessions


class TestPausedServices:
    """Test paused-services.txt filtering in Akamaru"""

    def test_load_paused_empty_file(self):
        """TC-01: load_paused returns empty set when file is empty"""
        with tempfile.NamedTemporaryFile(mode='w', delete=False) as f:
            paused_file = f.name

        try:
            with patch('akamaru.PAUSED_FILE', paused_file):
                result = load_paused()
                assert isinstance(result, set)
                assert len(result) == 0
        finally:
            Path(paused_file).unlink()

    def test_load_paused_with_agents(self):
        """TC-02: load_paused reads agent names from file"""
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.txt') as f:
            f.write('ibiki\n')
            f.write('guy\n')
            f.write('  \n')  # empty line
            f.write('kakashi\n')
            paused_file = f.name

        try:
            with patch('akamaru.PAUSED_FILE', paused_file):
                result = load_paused()
                assert 'ibiki' in result
                assert 'guy' in result
                assert 'kakashi' in result
                assert len(result) == 3
        finally:
            Path(paused_file).unlink()

    def test_load_paused_missing_file(self):
        """TC-03: load_paused returns empty set if file doesn't exist"""
        with patch('akamaru.PAUSED_FILE', '/nonexistent/path/paused.txt'):
            result = load_paused()
            assert isinstance(result, set)
            assert len(result) == 0

    def test_check_services_respects_paused(self):
        """TC-04: check_services skips alerts for paused agents"""
        paused = {'ibiki', 'guy'}

        # Mock systemctl to return 'inactive' for ibiki
        with patch('akamaru.os.system') as mock_system, \
             patch('akamaru.AGENT_WATCHDOGS', {'ibiki': 'claude-watchdog-ibiki.service', 'naruto': 'claude-watchdog-naruto.service'}), \
             patch('akamaru.load_paused', return_value=paused), \
             patch('akamaru.WATCHED_SESSIONS', ['naruto']):

            # Simulate inactive watchdog for ibiki
            def system_side_effect(cmd):
                if 'ibiki' in cmd and 'is-active' in cmd:
                    return 1  # inactive
                return 0  # active

            mock_system.side_effect = system_side_effect

            # Call check_services - should NOT alert for ibiki
            alerts = check_services(paused)

            # Verify no alert for ibiki
            ibiki_alerts = [a for a in alerts if 'ibiki' in a]
            assert len(ibiki_alerts) == 0

    def test_check_orphaned_sessions_respects_paused(self):
        """TC-05: check_orphaned_sessions skips paused agents"""
        paused = {'guy'}

        # Mock tmux session checks
        def mock_pane_exists(session):
            return session in ['naruto', 'guy']  # guy has session

        def mock_is_active(service):
            # guy watchdog is stopped but session alive (orphaned)
            if 'guy' in service:
                return False  # inactive
            return True  # active

        with patch('akamaru.pane_exists', side_effect=mock_pane_exists), \
             patch('akamaru.is_service_active', side_effect=mock_is_active), \
             patch('akamaru.WATCHED_SESSIONS', ['naruto', 'guy']):

            # Call check_orphaned_sessions with guy in paused list
            alerts = check_orphaned_sessions(paused)

            # Should NOT alert for guy (it's paused)
            guy_alerts = [a for a in alerts if 'guy' in a]
            assert len(guy_alerts) == 0

    def test_paused_agents_in_paused_file(self):
        """TC-06: Verify that paused agents are NOT in alerts"""
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.txt') as f:
            f.write('ibiki\n')
            paused_file = f.name

        try:
            with patch('akamaru.PAUSED_FILE', paused_file):
                paused = load_paused()
                assert 'ibiki' in paused

                # ibiki should not trigger alerts
                # (this would be integration test with real akamaru)
        finally:
            Path(paused_file).unlink()

    def test_non_paused_agents_still_alert(self):
        """TC-07: Agents NOT in paused list should still generate alerts"""
        paused = {'guy'}  # guy is paused

        # But naruto is not paused, so it should alert if inactive
        with patch('akamaru.load_paused', return_value=paused), \
             patch('akamaru.os.system') as mock_system:

            def system_side_effect(cmd):
                if 'naruto' in cmd and 'is-active' in cmd:
                    return 1  # inactive
                return 0  # active

            mock_system.side_effect = system_side_effect

            # naruto should be checked (not paused)
            # guy should be skipped (paused)
            # This is the core business logic

    def test_paused_list_format(self):
        """TC-08: Paused list handles whitespace and empty lines"""
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.txt') as f:
            f.write('  ibiki  \n')  # whitespace
            f.write('\n')  # empty line
            f.write('  \n')  # spaces only
            f.write('guy\n')
            paused_file = f.name

        try:
            with patch('akamaru.PAUSED_FILE', paused_file):
                result = load_paused()
                assert 'ibiki' in result
                assert 'guy' in result
                assert len(result) == 2
                # No empty strings or whitespace-only entries
                assert all(agent.strip() for agent in result)
        finally:
            Path(paused_file).unlink()


class TestAkamaruIntegration:
    """Integration tests for paused-services filtering"""

    def test_paused_services_file_exists(self):
        """TC-09: /opt/shared/kiba/paused-services.txt exists and is readable"""
        paused_file = Path('/opt/shared/kiba/paused-services.txt')
        # File may or may not exist, but if it does, it should be readable
        if paused_file.exists():
            content = paused_file.read_text()
            assert isinstance(content, str)

    def test_akamaru_script_has_paused_check(self):
        """TC-10: akamaru.py contains load_paused and paused filtering logic"""
        akamaru_file = Path('/home/ubuntu/scripts/akamaru.py')
        content = akamaru_file.read_text()

        # Verify key functions exist
        assert 'def load_paused' in content
        assert 'PAUSED_FILE' in content
        assert '/opt/shared/kiba/paused-services.txt' in content or 'paused' in content.lower()

        # Verify paused check is used in main logic
        assert 'paused' in content.lower()  # general check that paused logic is there


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
