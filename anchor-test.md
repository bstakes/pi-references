# Anchor navigation test

The target heading is near the bottom of this document, after twelve sections.
Opening the anchored link should scroll past all of them to **Test section**.
Opening at the top means the heading jump did not happen.

## Section 1: Starting point

This is the beginning of the document, not the navigation target.

The target is intentionally several screens below this introduction.

If this paragraph is visible after opening the anchored link, check whether
cmux received the fragment and whether its Markdown viewer supports it.

## Section 2: Discovery

File discovery and heading navigation are separate checks.

The file can appear in the picker even when a heading fragment is lost.

A successful discovery test alone does not establish that scrolling works.

## Section 3: Link destination

The test link ends with `#test-section`.

That fragment identifies the heading near the end of this file.

The intended destination is not one of these numbered sections.

## Section 4: Opening

Opening a local Markdown file may use a different viewer from a web page.

The selected opener must receive enough information to identify the heading.

A file path without a fragment identifies only the document.

## Section 5: Viewer behavior

The viewer also needs to understand Markdown heading identifiers.

Different viewers can generate different identifiers for complex headings.

This test uses a simple heading to avoid punctuation and duplicate names.

## Section 6: Halfway marker

You are approximately halfway through the filler sections.

This heading is not the target of the test link.

Keep scrolling if you are checking the destination manually.

## Section 7: Visible position

A successful jump should put the target heading in view.

The exact placement may depend on the viewer and the viewport height.

It should not leave you at the document introduction.

## Section 8: Address display

The address bar is useful evidence of what the viewer received.

A missing fragment may indicate it was stripped before reaching the viewer.

It could also mean the viewer displays a normalized address; inspect the
opener arguments before drawing a conclusion from the address bar alone.

## Section 9: Reopening

Close the viewer before repeating the test if it remembers scroll position.

Otherwise a restored position could look like successful anchor navigation.

Compare opening the plain file with opening the anchored link.

## Section 10: Plain-file comparison

The plain file should normally open at the beginning in a fresh viewer.

The anchored link should open much farther down, at the target heading.

That visible difference is the purpose of this longer document.

## Section 11: Near the destination

There is still one filler section before the navigation target.

This paragraph provides additional distance from the top of the file.

Do not count landing here as an exact heading jump.

## Section 12: Last filler section

The target heading follows this section.

Its text is **Test section**, and its expected fragment is `test-section`.

The success marker below should be visible after a working heading jump.

## Test section

**ANCHOR TARGET — you should land here, not at the top.**

If this heading and marker are visible immediately after opening the link
in a fresh viewer, heading navigation worked.

## After the target

This small trailing section leaves room below the target heading.

End of the anchor navigation test.
