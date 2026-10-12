-- Saves Word documents as PDF with Microsoft Word for Mac, laid out exactly as Word prints them.
-- Called by src/docx/page-exporters.ts with pairs of POSIX paths: document, PDF, document, PDF, ...
-- The documents are temporary copies made for rendering; each is closed without saving. A Word the
-- user already had open is left open, with their own documents untouched.
on run argv
	set startedHere to not (application "Microsoft Word" is running)
	try
		repeat with pairIndex from 1 to (count of argv) by 2
			set docPath to item pairIndex of argv
			set pdfPath to item (pairIndex + 1) of argv
			set docFile to POSIX file docPath
			set docName to do shell script "basename " & quoted form of docPath
			tell application "Microsoft Word"
				open docFile
				set theDoc to document docName
				try
					save as theDoc file name pdfPath file format format PDF
				on error
					-- Older Word for Mac builds take the path in the classic colon-separated form.
					save as theDoc file name ((POSIX file pdfPath) as text) file format format PDF
				end try
				close theDoc saving no
			end tell
		end repeat
	on error message number code
		if startedHere then tell application "Microsoft Word" to quit saving no
		error message number code
	end try
	if startedHere then tell application "Microsoft Word" to quit saving no
end run
