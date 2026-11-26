import frappe
from frappe.model.document import Document

from process_engine.process_engine.processes.linked_create import INSTANCE, opted_config, unavailable


class ProzessAufgabe(Document):
	def _protect_linked_create(self):
		# Parent saves write child rows in bulk after validating the complete document.
		# A direct child save must not move or alter a protected row.
		previous = self.get_doc_before_save()
		for row in (previous, self):
			if row and row.parenttype == INSTANCE and row.parent:
				doc = frappe.get_doc(INSTANCE, row.parent)
				if opted_config(doc, row):
					unavailable()

	def validate(self):
		self._protect_linked_create()

	def on_trash(self):
		self._protect_linked_create()
