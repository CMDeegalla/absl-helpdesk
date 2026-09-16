-- =====================================================================
-- 0013_attachment_cleanup.sql
--
-- There was no way to remove an attachment once uploaded - no DELETE
-- policy on ticket_attachments and none on the storage buckets either, so
-- an accidental duplicate, a blurry retake, or an old test photo sat
-- there forever with no way to reclaim the space.
--
-- Whoever uploaded a photo/voice/video, or an admin, can now delete it.
-- The service call receipt photo is deliberately excluded: it is the
-- required evidence behind a resolution and, once a ticket resolves,
-- behind an already-generated resolution receipt (0010) that copied its
-- storage path - deleting the file out from under a receipt that already
-- references it would leave that receipt's photo permanently broken.
--
-- Idempotent: safe to re-run.
-- =====================================================================

DROP POLICY IF EXISTS "Uploader or admin deletes attachment" ON public.ticket_attachments;
CREATE POLICY "Uploader or admin deletes attachment"
ON public.ticket_attachments FOR DELETE
TO authenticated
USING (
  file_type <> 'service_receipt'
  AND (uploaded_by = auth.uid() OR public.is_admin())
);

-- Storage: the same rule, so removing the database row and the file it
-- points to can happen together. can_access_ticket_file() already covers
-- ticket visibility; this adds the uploader-or-admin ownership check on
-- top of it, mirroring the table policy above.
-- Deliberately excludes ticket-service-receipts, for the same reason the
-- table policy excludes file_type = 'service_receipt' above - there is no
-- legitimate path to delete that file, so it is left out of this policy
-- entirely rather than relying only on the application layer to enforce it.
DROP POLICY IF EXISTS "Uploader or admin deletes ticket file" ON storage.objects;
CREATE POLICY "Uploader or admin deletes ticket file"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id IN ('ticket-photos', 'ticket-voice-notes', 'ticket-videos')
  AND (owner = auth.uid() OR public.is_admin())
);
