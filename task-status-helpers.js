// Helper functions for task status badges and icons

function getStatusBadgeClass(status) {
  const statusClasses = {
    'pending': 'bg-amber-100 text-amber-800',
    'working': 'bg-blue-100 text-blue-800',
    'at_workstation': 'bg-blue-100 text-blue-800',
    'success': 'bg-green-100 text-green-800',
    'completed': 'bg-green-100 text-green-800',
    'error': 'bg-red-100 text-red-800',
    'failed': 'bg-red-100 text-red-800'
  };
  return statusClasses[status] || 'bg-gray-100 text-gray-800';
}

function getStatusIcon(status) {
  const statusIcons = {
    'pending': '<i class="fas fa-clock mr-1"></i>',
    'working': '<i class="fas fa-cogs fa-spin mr-1"></i>',
    'at_workstation': '<i class="fas fa-cogs fa-spin mr-1"></i>',
    'success': '<i class="fas fa-check-circle mr-1"></i>',
    'completed': '<i class="fas fa-check-circle mr-1"></i>',
    'error': '<i class="fas fa-exclamation-triangle mr-1"></i>',
    'failed': '<i class="fas fa-exclamation-triangle mr-1"></i>'
  };
  return statusIcons[status] || '<i class="fas fa-question-circle mr-1"></i>';
}

function convertStatusLabel(status) {
  const statusLabels = {
    'pending': 'รอดำเนินการ',
    'working': 'กำลังทำงาน',
    'at_workstation': 'ที่สถานีงาน',
    'success': 'สำเร็จ',
    'completed': 'เสร็จสิ้น',
    'error': 'เกิดข้อผิดพลาด',
    'failed': 'ล้มเหลว'
  };
  return statusLabels[status] || status;
}