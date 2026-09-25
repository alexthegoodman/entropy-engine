Feature: Many songs, each with a version history

  The DAW keeps a library of songs instead of one DAW.json. Every song saves itself as you work;
  switching songs never asks to save and never loses anything. Each song keeps versions: one every
  10 minutes while it changes, one when it is opened, one before a restore, and any you save by
  hand. The production addon runs against a stand-in engine whose store is an in-memory disk, so a
  step can close the DAW and open it again on the same files.

  Scenario: The first run opens a demo song that is saved in the library
    Given the DAW is open
    Then the open song is "Demo song"
    And the song bar says "Demo song"
    And the library has 1 song

  Scenario: An old single-file save becomes the first song, untouched
    Given the DAW is open on an old DAW.json at 111 BPM
    Then the open song is "My song"
    And the open song is at 111 BPM
    And the song has a version "Imported from the previous DAW save"

  Scenario: A new song never replaces the song you were working on
    Given the DAW is open
    When I click "bpm_up"
    And I create a new song from "Neon Tide - EDM (rising violins)"
    Then the open song is "Neon Tide"
    And the open song is at 128 BPM
    And the library has 2 songs
    When I open the song "Demo song"
    Then the open song is at 97 BPM

  Scenario: The DAW reopens on the song that was open last
    Given the DAW is open
    And I create a new song from "Blank song"
    When the DAW is closed and opened again
    Then the open song is "Untitled song"
    And the library has 2 songs

  Scenario: Songs are renamed in place, and names stay unique
    Given the DAW is open
    And I create a new song from "Blank song"
    When I rename the song "Untitled song" to "Late Night Idea"
    Then the song list shows "Late Night Idea"
    When I rename the song "Late Night Idea" to "Demo song"
    Then the song list shows "Demo song 2"

  Scenario: Duplicating makes an independent copy
    Given the DAW is open
    When I select the song "Demo song"
    And I click "song_duplicate"
    Then the song list shows "Demo song copy"
    And the library has 2 songs

  Scenario: Deleting the open song opens another, and Undo brings it back
    Given the DAW is open
    And I create a new song from "Blank song"
    When I select the song "Untitled song"
    And I click "song_delete"
    Then the open song is "Demo song"
    And the song list does not show "Untitled song"
    And Recently deleted has 1 song
    When I click "library_toast_action"
    Then the open song is "Untitled song"
    And Recently deleted has 0 songs

  Scenario: Deleting forever takes a second click
    Given the DAW is open
    And I create a new song from "Blank song"
    And I select the song "Untitled song"
    And I click "song_delete"
    When I select the deleted song "Untitled song"
    And I click "trash_delete_forever"
    Then Recently deleted has 1 song
    When I click "trash_delete_forever"
    Then Recently deleted has 0 songs
    And no file of the deleted song is left

  Scenario: Search narrows the song list
    Given the DAW is open
    And I create a new song from "Afterhours - House (cello chops)"
    And I create a new song from "Lowlight - Hip Hop (drum breakdown)"
    When I set "song_search" to "after"
    Then the song list shows only "Afterhours"

  Scenario: A version is kept every 10 minutes while the song changes, never while it sits idle
    Given the DAW is open
    Then the song has 1 version
    When 30 minutes pass
    Then the song has 1 version
    When I click "bpm_up"
    And 11 minutes pass
    Then the song has 2 versions

  Scenario: Restoring a version can itself be undone
    Given the DAW is open
    When I click "bpm_up"
    And I click "bpm_up"
    And 11 minutes pass
    And I click "bpm_up"
    Then the open song is at 99 BPM
    When I restore the oldest version
    Then the open song is at 96 BPM
    And the song has a version "Before restoring"
    When I click "library_toast_action"
    Then the open song is at 99 BPM

  Scenario: Ctrl+S and named versions
    Given the DAW is open
    When I click "bpm_up"
    And I press Ctrl+S
    Then the song has 2 versions
    When I press Ctrl+S
    Then the song has 2 versions
    When I set "version_name" to "Before the drop"
    And I click "version_save"
    Then the song has a version "Before the drop"

  Scenario: A version can be opened as a new song, leaving the original alone
    Given the DAW is open
    When I click "bpm_up"
    And 11 minutes pass
    And I open the oldest version as a new song
    Then the open song is at 96 BPM
    And the library has 2 songs
    When I open the song "Demo song"
    Then the open song is at 97 BPM

  Scenario: The assistant can list, create and open songs
    Given the DAW is open
    When the assistant creates a song called "Robot Funk"
    Then the open song is "Robot Funk"
    When the assistant opens the song "Demo song"
    Then the open song is "Demo song"
    And the assistant lists 2 songs
